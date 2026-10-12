import { describe, expect, it } from "vitest";
import { presignUrl } from "@/lib/evidence/presign";
import type { BucketLocation } from "@/lib/evidence/upload-policy";

/**
 * ADR-0010 — the signer is checked against AWS's own published presigned-URL
 * example ("Example: Presigned URL", sigv4-query-string-auth), not against
 * itself. A hand-rolled SigV4 that only agrees with its own output proves
 * nothing; this vector is the external oracle.
 */
const AWS_EXAMPLE_LOCATION: BucketLocation = {
  provider: "s3",
  bucket: "examplebucket",
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  style: "virtual-hosted",
};

const AWS_EXAMPLE_CREDENTIAL = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("presignUrl — AWS published test vector", () => {
  it("reproduces the documented GET /test.txt signature exactly", () => {
    const url = presignUrl({
      method: "GET",
      location: AWS_EXAMPLE_LOCATION,
      key: "test.txt",
      credential: AWS_EXAMPLE_CREDENTIAL,
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});

describe("presignUrl — the grant's shape", () => {
  const PUT_ARGS = {
    method: "PUT" as const,
    key: "tasks/pr_1/abc-photo.jpg",
    credential: AWS_EXAMPLE_CREDENTIAL,
    expiresSeconds: 600,
    headers: { "Content-Type": "image/jpeg", "Content-Length": "1234" },
    now: new Date("2026-09-28T00:00:00Z"),
  };

  it("signs content-type and content-length, so a different file fails the provider's check", () => {
    const url = new URL(presignUrl({ ...PUT_ARGS, location: AWS_EXAMPLE_LOCATION }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    const other = new URL(
      presignUrl({ ...PUT_ARGS, location: AWS_EXAMPLE_LOCATION, headers: { "Content-Type": "image/jpeg", "Content-Length": "9999" } }),
    );
    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(url.searchParams.get("X-Amz-Signature"));
  });

  it("puts the bucket in the path for R2 and carries a session token when given", () => {
    const url = new URL(
      presignUrl({
        ...PUT_ARGS,
        credential: { ...AWS_EXAMPLE_CREDENTIAL, sessionToken: "tok/en+1" },
        location: { provider: "s3", bucket: "evidence", host: "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", region: "auto", style: "path" },
      }),
    );
    expect(url.pathname).toBe("/evidence/tasks/pr_1/abc-photo.jpg");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("tok/en+1");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
  });

  it("uses the GOOG4 scheme and X-Goog parameters for GCS", () => {
    const url = new URL(
      presignUrl({
        ...PUT_ARGS,
        location: { provider: "gcs", bucket: "evidence", host: "storage.googleapis.com", region: "auto", style: "path" },
      }),
    );
    expect(url.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-HMAC-SHA256");
    expect(url.searchParams.get("X-Goog-Credential")).toContain("/auto/storage/goog4_request");
    expect(url.searchParams.get("X-Goog-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.has("X-Amz-Signature")).toBe(false);
  });
});
