/**
 * upload-policy.ts — the rules for evidence upload grants (ADR-0010).
 *
 * Pure and client-safe: no network, no node:crypto, no secrets. The server
 * route and the MCP tool validate against these; the dashboard reads the
 * limits to reject a file before asking for a grant it would be refused.
 *
 * The platform never holds evidence bytes (ADR-0010 D1). What it does hold is
 * a write-only credential for the hiring agent's own bucket, and what it hands
 * out is a short-lived pre-signed PUT for exactly one object. Everything here
 * exists to keep that grant narrow: one allowlisted host shape per provider,
 * one per-task key prefix, one declared content type, one declared size.
 */

/** ADR-0010 D5 — platform maximum per artefact; an agent may set it lower. */
export const PLATFORM_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** ADR-0010 D2 — pre-signed PUT lifetime, "TTL ≤ 10 minutes". */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;

/** ADR-0010 D5 — content-type allowlist: phone photos and documents. */
export const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/pdf",
] as const;

export type UploadContentType = (typeof ALLOWED_UPLOAD_TYPES)[number];

export function isAllowedUploadType(type: string): type is UploadContentType {
  return (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(type);
}

/** The value for an `<input type="file" accept>` that matches the allowlist. */
export const UPLOAD_ACCEPT_ATTRIBUTE = ALLOWED_UPLOAD_TYPES.join(",");

export type UploadProvider = "s3" | "gcs";

/**
 * Where a grant points: the host to sign for, the bucket, whether the bucket
 * goes in the host (AWS virtual-hosted) or the path (R2, GCS), and the region
 * string that goes into the SigV4 credential scope.
 */
export interface BucketLocation {
  provider: UploadProvider;
  bucket: string;
  host: string;
  region: string;
  style: "virtual-hosted" | "path";
}

export type LocationResult =
  | { ok: true; location: BucketLocation }
  | { ok: false; error: string };

/** AWS/R2 bucket naming, minus dots (a dotted name breaks virtual-hosted TLS). */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** GCS allows underscores; dots are refused here for the same TLS reason. */
const GCS_BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;
const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const R2_ENDPOINT = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com\/?$/;

/**
 * Resolve the spec's `evidence_bucket` plus the agent's credential metadata
 * into a signable location.
 *
 * `target` conventions (the spec field is a free string, and is part of the
 * spec hash preimage, so it carries only the bucket — never a secret):
 *   - s3:  `s3://<bucket>`   — AWS S3 (needs `region`), or Cloudflare R2
 *                              (needs `endpoint` = https://<account>.r2.cloudflarestorage.com)
 *   - gcs: `gs://<bucket>`   — Google Cloud Storage via its S3-compatible XML
 *                              API, with an HMAC key
 *
 * Hosts are derived, never free-form: the browser PUTs to this host, so an
 * arbitrary endpoint would both widen the page's CSP and let an agent point a
 * worker's upload anywhere. R2 and AWS regional hosts are the only S3 shapes
 * accepted; anything else (MinIO, self-hosted) stays on the `https` provider,
 * which remains worker-self-hosted (ADR-0010 D2).
 */
export function resolveBucketLocation(
  provider: string,
  target: string,
  opts: { region?: string; endpoint?: string },
): LocationResult {
  if (provider === "gcs") {
    const m = /^gs:\/\/([^/]+)\/?$/.exec(target.trim());
    if (!m || !GCS_BUCKET_NAME.test(m[1])) {
      return { ok: false, error: 'evidence_bucket.target for gcs must be "gs://<bucket>" (lowercase, no dots).' };
    }
    return {
      ok: true,
      location: {
        provider: "gcs",
        bucket: m[1],
        host: "storage.googleapis.com",
        region: "auto",
        style: "path",
      },
    };
  }

  if (provider === "s3") {
    const m = /^s3:\/\/([^/]+)\/?$/.exec(target.trim());
    if (!m || !BUCKET_NAME.test(m[1])) {
      return { ok: false, error: 'evidence_bucket.target for s3 must be "s3://<bucket>" (lowercase, no dots).' };
    }
    const bucket = m[1];
    if (opts.endpoint) {
      const r2 = R2_ENDPOINT.exec(opts.endpoint.trim());
      if (!r2) {
        return {
          ok: false,
          error:
            "endpoint must be a Cloudflare R2 account endpoint (https://<account-id>.r2.cloudflarestorage.com). For AWS S3 omit endpoint and pass region.",
        };
      }
      return {
        ok: true,
        location: { provider: "s3", bucket, host: `${r2[1]}.r2.cloudflarestorage.com`, region: "auto", style: "path" },
      };
    }
    if (!opts.region || !AWS_REGION.test(opts.region)) {
      return { ok: false, error: "region is required for AWS S3 (e.g. ap-southeast-2)." };
    }
    return {
      ok: true,
      location: {
        provider: "s3",
        bucket,
        host: `${bucket}.s3.${opts.region}.amazonaws.com`,
        region: opts.region,
        style: "virtual-hosted",
      },
    };
  }

  return {
    ok: false,
    error: `evidence_bucket.provider "${provider}" cannot take platform-minted uploads — only s3 and gcs can (ADR-0010 D2). https buckets stay worker-hosted.`,
  };
}

/**
 * Keep a worker's filename readable in the agent's bucket without letting it
 * shape the key: no path separators, no leading dots, ASCII-safe, bounded.
 */
export function sanitiseFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(-80);
  return cleaned || "evidence";
}

/**
 * `tasks/<payment_request_id>/<random>-<filename>` — the per-task prefix the
 * agent's credential is scoped to (ADR-0010 D2), and a random component so one
 * upload can never land on another's key.
 */
export function objectKeyFor(paymentRequestId: string, random: string, filename: string): string {
  return `tasks/${paymentRequestId}/${random}-${sanitiseFilename(filename)}`;
}

/** The object's canonical https URI — what goes into the evidence bundle (D4: never rewritten). */
export function objectUri(location: BucketLocation, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return location.style === "virtual-hosted"
    ? `https://${location.host}/${encodedKey}`
    : `https://${location.host}/${location.bucket}/${encodedKey}`;
}

export type UploadRequestCheck =
  | { ok: true; contentType: UploadContentType; sizeBytes: number }
  | { ok: false; error: string };

/** Validate what a worker asks to upload, against the effective cap. */
export function checkUploadRequest(
  contentType: unknown,
  sizeBytes: unknown,
  capBytes: number,
): UploadRequestCheck {
  if (typeof contentType !== "string" || !isAllowedUploadType(contentType)) {
    return {
      ok: false,
      error: "That file type can't be uploaded here. Use a photo (JPEG, PNG, HEIC, WebP) or a PDF.",
    };
  }
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "The file is empty or its size could not be read." };
  }
  if (sizeBytes > capBytes) {
    return {
      ok: false,
      error: `That file is ${formatMb(sizeBytes)} — this task accepts up to ${formatMb(capBytes)} per file.`,
    };
  }
  return { ok: true, contentType, sizeBytes };
}

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
