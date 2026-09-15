/**
 * r2.ts — push and read back objects in Cloudflare R2 over its S3-compatible
 * API, for the ADR-0006 D8 off-vendor backup export (CC-107).
 *
 * WHY HAND-ROLLED SIGV4, NOT @aws-sdk/client-s3
 *
 * The repo is under a dependency freeze (root HERMES.md): no new external
 * dependencies without explicit PO approval. A single-bucket PUT/GET with
 * standard headers is a small, well-specified request — a handful of hashes
 * and one HMAC chain — which fits in well under 200 lines of node:crypto with
 * nothing to install and nothing to audit. The moment the platform needs
 * multipart upload, object versioning or ListObjectsV2 pagination, this file
 * gets replaced by the real SDK; the surface is deliberately just
 * putObject/getObject so that swap is mechanical.
 *
 * SigV4 (header-based): https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 * R2 S3 API:            https://developers.cloudflare.com/r2/api/s3/api/
 *
 * SECURITY SHAPE
 *
 * - Credentials live only in the environment of the calling process (the
 *   Vercel cron function; the audit script reads .env.local). They never
 *   appear in log lines or error messages — errors carry status and key only.
 * - The host is derived from the account id, never accepted from the
 *   environment, so a mistyped env var cannot redirect an Authorization
 *   header to an arbitrary host. The signature covers the host anyway; this
 *   is the stronger property of not sending it at all.
 *
 * Server-side only: network I/O, node:crypto. Nothing under src/app imports
 * this from a client component.
 */

import { createHash, createHmac } from "node:crypto";

/** R2 credentials, created by the PO in the Cloudflare dashboard (CC-108). */
export interface R2Credentials {
  /** 32-hex Cloudflare account id (the one in the dashboard URL). */
  accountId: string;
  /** R2 Access Key ID. */
  accessKeyId: string;
  /** R2 Secret Access Key. Bearer secret — never log, never echo. */
  secretAccessKey: string;
}

/** Result of a successful putObject. */
export interface PutObjectResult {
  key: string;
  /** HTTP status — 200/201 on success. */
  status: number;
  /** ETag R2 returned. For a non-multipart PUT this is the quoted MD5 of the
   *  body — a cheap cross-check alongside the exporter's own sha256. */
  etag: string | null;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/**
 * R2 accepts "auto" in the SigV4 credential scope — this is Cloudflare's
 * documented value (their own SigV4 examples use it), and unlike a region
 * name it cannot silently change meaning if R2 ever moves the bucket.
 */
const REGION = "auto";

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC3986 percent-encoding for one path segment (slashes not preserved). */
function uriEncodeSegment(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

export function r2EndpointHost(accountId: string): string {
  return `${accountId}.r2.cloudflaredstorage.com`;
}

/** Canonical URI: slash-separated, each segment encoded, e.g.
 *  /cc-backups/2026/09/16/manifest.json */
function canonicalUriFor(bucket: string, key: string): string {
  return ["", bucket, ...key.split("/").map(uriEncodeSegment)].join("/");
}

interface SignArgs {
  method: "PUT" | "GET";
  creds: R2Credentials;
  bucket: string;
  key: string;
  body: Buffer;
  /** Extra unsigned headers (content-type). x-amz-* and host are always
   *  signed; anything optional stays out of the signed set unless it must be
   *  there, keeping the wire bytes and the signature in lockstep. */
  unsignedHeaders?: Record<string, string>;
}

/**
 * Build and send one SigV4-signed S3 request. Returns the Response; callers
 * decide how to interpret failures so PUT and GET keep their own error shape.
 *
 * The `host` header is deliberately not set on the outgoing fetch — undici
 * derives it from the URL, and the URL host is the exact string the canonical
 * headers were built from, so signed and wire values cannot diverge.
 */
async function signedRequest(args: SignArgs): Promise<Response> {
  const { method, creds, bucket, key, body } = args;
  const host = r2EndpointHost(creds.accountId);
  const canonicalUri = canonicalUriFor(bucket, key);
  const url = `https://${host}${canonicalUri}`;

  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const signedHeadersMap: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(signedHeadersMap).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signedHeadersMap[name].trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // no query string on these requests
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(Buffer.from(canonicalRequest, "utf8"))].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), REGION), SERVICE),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const wireHeaders: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: authorization,
    ...(args.unsignedHeaders ?? {}),
  };
  if (method === "PUT") {
    // Undici sets content-length from the body itself; stating it explicitly
    // keeps one source of truth for what is on the wire.
    wireHeaders["content-length"] = String(body.byteLength);
  }

  return fetch(url, {
    method,
    headers: wireHeaders,
    body: method === "PUT" ? new Uint8Array(body) : undefined,
  });
}

/** Error text for a failed S3 call: status, key, and a bounded body snippet.
 *  Never request headers (which echo the Authorization), never credentials. */
async function failureDetail(response: Response, key: string): Promise<string> {
  const text = await response.text().catch(() => "");
  return `R2 ${key} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 300)}` : ""}`;
}

/** PUT one object. Throws (scrubbed) on any non-2xx or network error. */
export async function putObject(
  creds: R2Credentials,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<PutObjectResult> {
  let response: Response;
  try {
    response = await signedRequest({ method: "PUT", creds, bucket, key, body, unsignedHeaders: { "content-type": contentType } });
  } catch (err) {
    // Network-level failure. The URL carries bucket/account but no secrets.
    throw new Error(`R2 PUT ${key} network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new Error(await failureDetail(response, key));
  }
  return { key, status: response.status, etag: response.headers.get("etag") };
}

/**
 * GET one object back. Used by the exporter's verification pass and by
 * scripts/audit/verify-backup-export.mjs: PUT the export, GET it back, hash
 * the bytes received and compare against the manifest. A backup that cannot
 * be read back is not a backup — that is D8's restore-test instinct applied
 * on every run, not once before mainnet.
 */
export async function getObject(creds: R2Credentials, bucket: string, key: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await signedRequest({ method: "GET", creds, bucket, key, body: Buffer.alloc(0) });
  } catch (err) {
    throw new Error(`R2 GET ${key} network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`R2 GET ${key}: object not found`);
    }
    throw new Error(await failureDetail(response, key));
  }
  return Buffer.from(await response.arrayBuffer());
}
