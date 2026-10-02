import { describe, expect, it } from "vitest";
import {
  PLATFORM_MAX_UPLOAD_BYTES,
  checkUploadRequest,
  objectKeyFor,
  objectUri,
  resolveBucketLocation,
  sanitiseFilename,
} from "@/lib/evidence/upload-policy";

describe("resolveBucketLocation (ADR-0010 D2)", () => {
  it("resolves AWS S3 to a regional virtual-hosted host", () => {
    const r = resolveBucketLocation("s3", "s3://agent-evidence", { region: "ap-southeast-2" });
    expect(r).toEqual({
      ok: true,
      location: {
        provider: "s3",
        bucket: "agent-evidence",
        host: "agent-evidence.s3.ap-southeast-2.amazonaws.com",
        region: "ap-southeast-2",
        style: "virtual-hosted",
      },
    });
  });

  it("resolves an R2 account endpoint to path style with region auto", () => {
    const r = resolveBucketLocation("s3", "s3://evidence", {
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    });
    expect(r.ok && r.location).toMatchObject({
      host: "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      region: "auto",
      style: "path",
    });
  });

  it("resolves gcs to the XML API host", () => {
    const r = resolveBucketLocation("gcs", "gs://agent_evidence", {});
    expect(r.ok && r.location.host).toBe("storage.googleapis.com");
  });

  it("refuses any endpoint that is not an R2 account host — no free-form upload targets", () => {
    for (const endpoint of [
      "https://evil.example.com",
      "http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.evil.com",
      "https://minio.internal:9000",
    ]) {
      expect(resolveBucketLocation("s3", "s3://evidence", { endpoint }).ok).toBe(false);
    }
  });

  it("refuses the https provider, dotted buckets, and AWS without a region", () => {
    expect(resolveBucketLocation("https", "https://files.example.com", {}).ok).toBe(false);
    expect(resolveBucketLocation("s3", "s3://my.bucket", { region: "us-east-1" }).ok).toBe(false);
    expect(resolveBucketLocation("s3", "s3://evidence", {}).ok).toBe(false);
    expect(resolveBucketLocation("s3", "evidence", { region: "us-east-1" }).ok).toBe(false);
  });
});

describe("object keys and URIs", () => {
  it("keeps every key under the task prefix, whatever the filename", () => {
    for (const name of ["../../etc/passwd", "a/b/c.jpg", "..\\x.png", ".hidden", "", "照片.jpg"]) {
      const key = objectKeyFor("pr_1", "r4nd", name);
      expect(key.startsWith("tasks/pr_1/r4nd-")).toBe(true);
      expect(key.slice("tasks/pr_1/".length)).not.toContain("/");
      expect(key).not.toContain("..");
    }
    expect(sanitiseFilename("IMG 0042 (1).HEIC")).toBe("IMG-0042-1-.HEIC");
  });

  it("builds the canonical https URI per style", () => {
    const aws = resolveBucketLocation("s3", "s3://evd", { region: "us-east-1" });
    const gcs = resolveBucketLocation("gcs", "gs://evd", {});
    if (!aws.ok || !gcs.ok) throw new Error("fixture");
    expect(objectUri(aws.location, "tasks/pr_1/x-a b.jpg")).toBe(
      "https://evd.s3.us-east-1.amazonaws.com/tasks/pr_1/x-a%20b.jpg",
    );
    expect(objectUri(gcs.location, "tasks/pr_1/x.jpg")).toBe(
      "https://storage.googleapis.com/evd/tasks/pr_1/x.jpg",
    );
  });
});

describe("checkUploadRequest (ADR-0010 D5)", () => {
  it("accepts an allowlisted type within the cap", () => {
    expect(checkUploadRequest("image/heic", 3_000_000, PLATFORM_MAX_UPLOAD_BYTES)).toEqual({
      ok: true,
      contentType: "image/heic",
      sizeBytes: 3_000_000,
    });
  });

  it("refuses other types, empty files, and files over the cap", () => {
    expect(checkUploadRequest("text/html", 10, PLATFORM_MAX_UPLOAD_BYTES).ok).toBe(false);
    expect(checkUploadRequest("image/svg+xml", 10, PLATFORM_MAX_UPLOAD_BYTES).ok).toBe(false);
    expect(checkUploadRequest("image/jpeg", 0, PLATFORM_MAX_UPLOAD_BYTES).ok).toBe(false);
    const over = checkUploadRequest("image/jpeg", 5 * 1024 * 1024 + 1, 5 * 1024 * 1024);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toContain("5.0 MB");
  });
});
