import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * GET /api/cron/backup-export (CC-107).
 *
 * Same pinning logic as retention-route.test.ts: the behaviour that matters
 * is not "it exports" (backup-export.test.ts covers the engine) but that an
 * unauthenticated caller can never trigger an export, that the route refuses
 * rather than runs when its own secret or its R2 target is unconfigured, and
 * that a partial/failed run is reported as not-ok rather than waved through.
 * /api/* bypasses the coming-soon gate, so this endpoint is internet-reachable
 * the moment it deploys, and it ships registration data off-vendor.
 */

const mockExport = vi.fn();
vi.mock("@/lib/db/backup-export", () => ({
  exportTier1ToR2: (...args: unknown[]) => mockExport(...args),
}));

let mockConfig: Record<string, string | undefined>;
vi.mock("@/lib/config", () => ({ getConfig: () => mockConfig }));

const SECRET = "s3cr3t-value-of-some-length";

const FULL_CONFIG: Record<string, string | undefined> = {
  CRON_SECRET: SECRET,
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  BACKUP_R2_BUCKET: "bucket",
};

function makeRequest(authorization?: string): NextRequest {
  return new Request("http://localhost/api/cron/backup-export", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;
}

function summary(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    rule_version: "cc107.test.1",
    generated_at: "2026-09-16T04:17:00.000Z",
    project_ref: "abc123def456ghi789jk",
    prefix: "tier1-backup/abc123def456ghi789jk/2026-09-16/0417Z",
    tables: [
      { name: "humans", status: "exported", rows: 4, verified: true },
      { name: "stake_slashes", status: "absent", rows: 0 },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig = { ...FULL_CONFIG };
  mockExport.mockResolvedValue(summary());
});

describe("GET /api/cron/backup-export (CC-107)", () => {
  it("refuses to run when CRON_SECRET is unset — fails closed", async () => {
    mockConfig = { ...FULL_CONFIG, CRON_SECRET: undefined };
    const { GET } = await import("@/app/api/cron/backup-export/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("treats a blank CRON_SECRET as unset (CC-097)", async () => {
    mockConfig = { ...FULL_CONFIG, CRON_SECRET: "" };
    const { GET } = await import("@/app/api/cron/backup-export/route");

    const res = await GET(makeRequest("Bearer "));
    expect(res.status).toBe(503);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const { GET } = await import("@/app/api/cron/backup-export/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("401s on a wrong secret, wrong scheme, or a secret prefix", async () => {
    const { GET } = await import("@/app/api/cron/backup-export/route");

    expect((await GET(makeRequest("Bearer not-the-secret"))).status).toBe(401);
    expect((await GET(makeRequest(`Basic ${SECRET}`))).status).toBe(401);
    expect((await GET(makeRequest(`Bearer ${SECRET.slice(0, 5)}`))).status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("refuses with 503 and a CC-109 pointer when the R2 target is unconfigured", async () => {
    // Authenticated correctly — the missing piece is provisioning, not auth.
    mockConfig = { ...FULL_CONFIG, BACKUP_R2_BUCKET: undefined };
    const { GET } = await import("@/app/api/cron/backup-export/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/CC-109/);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("refuses when any one of the four R2 vars is blank (CC-097)", async () => {
    for (const blanked of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "BACKUP_R2_BUCKET"]) {
      mockConfig = { ...FULL_CONFIG, [blanked]: "" };
      const { GET } = await import("@/app/api/cron/backup-export/route");
      const res = await GET(makeRequest(`Bearer ${SECRET}`));
      expect(res.status).toBe(503);
    }
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("runs the export when fully configured and echoes the summary", async () => {
    const { GET } = await import("@/app/api/cron/backup-export/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(mockExport).toHaveBeenCalledOnce();
    const body = (await res.json()) as { ok: boolean; prefix: string };
    expect(body.ok).toBe(true);
    expect(body.prefix).toContain("tier1-backup");
  });

  it("propagates ok:false (failed table or verification mismatch) instead of 500ing", async () => {
    mockExport.mockResolvedValue(
      summary({
        ok: false,
        tables: [{ name: "humans", status: "failed", rows: 0, error: "boom" }],
      }),
    );
    const { GET } = await import("@/app/api/cron/backup-export/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("500s safely when the engine itself throws (misconfiguration)", async () => {
    mockExport.mockRejectedValue(new Error("spec violation"));
    const { GET } = await import("@/app/api/cron/backup-export/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockExport).toHaveBeenCalledOnce();
  });
});
