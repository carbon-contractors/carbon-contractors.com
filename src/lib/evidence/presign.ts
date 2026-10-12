/**
 * presign.ts — query-string SigV4 pre-signed URLs for one evidence object
 * (ADR-0010 D2). Server-side only (node:crypto; handles a bucket secret).
 *
 * Hand-rolled for the same reason as `src/lib/r2.ts`: the dependency freeze,
 * and a surface small enough to verify against the providers' published test
 * vectors instead of trusting an SDK's (see presign.test.ts).
 *
 *   AWS S3 / R2 — AWS4-HMAC-SHA256, scope <date>/<region>/s3/aws4_request,
 *                 X-Amz-* parameters.
 *                 https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *   GCS (HMAC)  — the same construction under GOOG4-HMAC-SHA256, scope
 *                 <date>/<location>/storage/goog4_request, X-Goog-* parameters.
 *                 https://cloud.google.com/storage/docs/access-control/signing-urls-manually
 *
 * The payload is UNSIGNED-PAYLOAD (the browser holds the bytes; the platform
 * never sees them, ADR-0010 D1). What IS signed, besides host: content-type and
 * content-length, so the grant is good for exactly the file the worker
 * declared — a different type or a larger file fails the provider's signature
 * check. That is the size cap's enforcement; a pre-signed PUT has no
 * content-length-range the way a POST policy does.
 *
 * Nothing here logs. The secret never leaves the HMAC chain, and the returned
 * URL is itself a bearer grant — callers must not log it either.
 */

import { createHash, createHmac } from "node:crypto";
import type { BucketLocation } from "./upload-policy";

export interface BucketCredential {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS session token, when the agent mints a temporary credential. */
  sessionToken?: string;
}

export interface PresignArgs {
  method: "PUT" | "GET";
  location: BucketLocation;
  key: string;
  credential: BucketCredential;
  expiresSeconds: number;
  /** Signed headers beyond host, lowercase names. */
  headers?: Record<string, string>;
  /** Injectable for test vectors. */
  now?: Date;
}

interface Scheme {
  algorithm: string;
  service: string;
  terminator: string;
  keyPrefix: string;
  paramPrefix: "X-Amz" | "X-Goog";
}

const AWS_SCHEME: Scheme = {
  algorithm: "AWS4-HMAC-SHA256",
  service: "s3",
  terminator: "aws4_request",
  keyPrefix: "AWS4",
  paramPrefix: "X-Amz",
};

const GOOG_SCHEME: Scheme = {
  algorithm: "GOOG4-HMAC-SHA256",
  service: "storage",
  terminator: "goog4_request",
  keyPrefix: "GOOG4",
  paramPrefix: "X-Goog",
};

/** RFC 3986 unreserved characters pass; everything else is %XX (uppercase). */
function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** 20130524T000000Z */
function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function canonicalPath(location: BucketLocation, key: string): string {
  const encodedKey = uriEncode(key, true);
  return location.style === "virtual-hosted"
    ? `/${encodedKey}`
    : `/${uriEncode(location.bucket, false)}/${encodedKey}`;
}

export function presignUrl(args: PresignArgs): string {
  const scheme = args.location.provider === "gcs" ? GOOG_SCHEME : AWS_SCHEME;
  const now = args.now ?? new Date();
  const datetime = amzDate(now);
  const date = datetime.slice(0, 8);
  const scope = `${date}/${args.location.region}/${scheme.service}/${scheme.terminator}`;

  const headers: Record<string, string> = { host: args.location.host };
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    headers[name.toLowerCase()] = String(value).trim();
  }
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");
  const canonicalHeaders = headerNames.map((n) => `${n}:${headers[n]}\n`).join("");

  const p = scheme.paramPrefix;
  const query: Record<string, string> = {
    [`${p}-Algorithm`]: scheme.algorithm,
    [`${p}-Credential`]: `${args.credential.accessKeyId}/${scope}`,
    [`${p}-Date`]: datetime,
    [`${p}-Expires`]: String(args.expiresSeconds),
    [`${p}-SignedHeaders`]: signedHeaders,
  };
  if (args.credential.sessionToken) {
    query[`${p}-Security-Token`] = args.credential.sessionToken;
  }
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`)
    .join("&");

  const path = canonicalPath(args.location, args.key);
  const canonicalRequest = [
    args.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    scheme.algorithm,
    datetime,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const kDate = hmac(`${scheme.keyPrefix}${args.credential.secretAccessKey}`, date);
  const kRegion = hmac(kDate, args.location.region);
  const kService = hmac(kRegion, scheme.service);
  const kSigning = hmac(kService, scheme.terminator);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return `https://${args.location.host}${path}?${canonicalQuery}&${p}-Signature=${signature}`;
}
