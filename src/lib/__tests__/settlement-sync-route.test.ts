import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * GET /api/cron/settlement-sync (CC-080).
 *
 * Same posture pins as the retention route: it cannot be made to run by an
 * unauthenticated caller, and it refuses rather than runs when its own secret
 * is missing. `/api/*` bypasses the coming-soon gate, so this endpoint is
 * internet-reachable the moment it deploys, and it writes task status with the
 * service-role key. `settlement-sync.test.ts` covers the mapping itself.
 */

const mockSync = vi.fn();
vi.mock("@/lib/db/settlement-sync", () => ({
  syncSettledTasks: (...args: unknown[]) => mockSync(...args),
}));

let mockCronSecret: string | undefined;
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ CRON_SECRET: mockCronSecret }),
}));

const SECRET = "s3cr3t-value-of-some-length";

function makeRequest(authorization?: string): NextRequest {
  return new Request("http://localhost/api/cron/settlement-sync", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;
}

function summary(over: Record<string, unknown> = {}) {
  return {
    considered: 3,
    updated: [
      { payment_request_id: "pr_1", from: "active", to: "completed", on_chain_state: "Completed" },
    ],
    unchanged: 1,
    mismatched: [],
    outcome_missing: [],
    failed: [{ payment_request_id: "pr_3", stage: "read", error: "HTTP request failed." }],
    ...over,
  };
}

describe("GET /api/cron/settlement-sync (CC-080)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCronSecret = SECRET;
    mockSync.mockResolvedValue(summary());
  });

  it("refuses to run at all when CRON_SECRET is unset — fails closed", async () => {
    mockCronSecret = undefined;
    const { GET } = await import("@/app/api/cron/settlement-sync/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("treats a blank CRON_SECRET as unset, not as a secret that empty matches", async () => {
    mockCronSecret = "";
    const { GET } = await import("@/app/api/cron/settlement-sync/route");

    const res = await GET(makeRequest("Bearer "));
    expect(res.status).toBe(503);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const { GET } = await import("@/app/api/cron/settlement-sync/route");

    expect((await GET(makeRequest())).status).toBe(401);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("401s on a wrong secret, a prefix of the secret, and the right secret with the wrong scheme", async () => {
    const { GET } = await import("@/app/api/cron/settlement-sync/route");

    expect((await GET(makeRequest("Bearer not-the-secret"))).status).toBe(401);
    expect((await GET(makeRequest(`Basic ${SECRET}`))).status).toBe(401);
    expect((await GET(makeRequest(`Bearer ${SECRET.slice(0, 5)}`))).status).toBe(401);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("runs the sync and returns counts, transitions and failing ids on a valid call", async () => {
    const { GET } = await import("@/app/api/cron/settlement-sync/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(json).toMatchObject({
      ok: true,
      considered: 3,
      updated: 1,
      unchanged: 1,
      mismatched: 0,
      outcome_missing: 0,
      failed: 1,
      transitions: [{ payment_request_id: "pr_1", from: "active", to: "completed" }],
      failures: ["pr_3"],
    });
    // The error text stays in the server log, not the response.
    expect(JSON.stringify(json)).not.toContain("HTTP request failed");
  });

  it("does not leak the sync's error message when the run throws", async () => {
    mockSync.mockRejectedValue(new Error("connection string: postgres://user:pw@host"));
    const { GET } = await import("@/app/api/cron/settlement-sync/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await res.json())).not.toContain("postgres://");
  });
});
