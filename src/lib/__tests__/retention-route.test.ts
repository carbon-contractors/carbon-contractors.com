import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * GET /api/cron/retention (CC-087).
 *
 * The behaviour worth pinning is not "it prunes" — `retention.test.ts` covers the engine.
 * It is that the route **cannot be made to prune by an unauthenticated caller**, and that
 * it refuses rather than opens up when its own secret is missing. `/api/*` bypasses the
 * coming-soon gate, so this endpoint is internet-reachable the moment it deploys, and it
 * deletes rows.
 */

const mockPrune = vi.fn();
vi.mock("@/lib/db/retention", () => ({
  pruneExpiredTaskContent: (...args: unknown[]) => mockPrune(...args),
  RETENTION_RULE_VERSION: "cc087.test.1",
}));

let mockCronSecret: string | undefined;
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ CRON_SECRET: mockCronSecret }),
}));

const SECRET = "s3cr3t-value-of-some-length";

function makeRequest(authorization?: string): NextRequest {
  return new Request("http://localhost/api/cron/retention", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;
}

function summary(over: Record<string, unknown> = {}) {
  return {
    rule_version: "cc087.test.1",
    cutoff: "2026-08-12T00:00:00.000Z",
    considered: 2,
    pruned: [{ payment_request_id: "pr_1", pruned: true, deleted_at: "2026-08-26T03:17:00Z" }],
    skipped: [{ payment_request_id: "pr_2", pruned: false, reason: "ineligible_at_engine" }],
    failed: [],
    ...over,
  };
}

describe("GET /api/cron/retention (CC-087)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCronSecret = SECRET;
    mockPrune.mockResolvedValue(summary());
  });

  it("refuses to run at all when CRON_SECRET is unset — fails closed", async () => {
    // The important one. An unset secret is a misconfiguration, not permission to run.
    // If this ever returns 200, the endpoint is an unauthenticated delete.
    mockCronSecret = undefined;
    const { GET } = await import("@/app/api/cron/retention/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it("treats a blank CRON_SECRET as unset, not as a secret that empty matches", async () => {
    // CC-097: a cleared Vercel field arrives as "". config.ts maps blank to undefined,
    // but assert the route's own guard is truthiness rather than `!== undefined`.
    mockCronSecret = "";
    const { GET } = await import("@/app/api/cron/retention/route");

    const res = await GET(makeRequest("Bearer "));
    expect(res.status).toBe(503);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const { GET } = await import("@/app/api/cron/retention/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it("401s on a wrong secret, and on a right secret with the wrong scheme", async () => {
    const { GET } = await import("@/app/api/cron/retention/route");

    expect((await GET(makeRequest("Bearer not-the-secret"))).status).toBe(401);
    expect((await GET(makeRequest(`Basic ${SECRET}`))).status).toBe(401);
    // A prefix must not pass — the compare is whole-value, not startsWith.
    expect((await GET(makeRequest(`Bearer ${SECRET.slice(0, 5)}`))).status).toBe(401);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns the D9 deletion record on a valid call", async () => {
    const { GET } = await import("@/app/api/cron/retention/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(json.ok).toBe(true);
    expect(json.rule_version).toBe("cc087.test.1");
    expect(json.considered).toBe(2);
    expect(json.pruned).toBe(1);
    expect(json.skipped).toBe(1);
    // ADR-0002 D9: identifiers and timing, auditable.
    expect(json.deletions).toEqual([
      { payment_request_id: "pr_1", deleted_at: "2026-08-26T03:17:00Z" },
    ]);
  });

  it("never returns task content, only identifiers", async () => {
    // D9's log trap, applied to the response body: if the engine ever starts
    // selecting content, this route must not become the thing that publishes it.
    mockPrune.mockResolvedValue(
      summary({
        pruned: [
          {
            payment_request_id: "pr_1",
            pruned: true,
            deleted_at: "2026-08-26T03:17:00Z",
            // Something a future change might carelessly attach:
            task_description: "secret location: 12 Main St",
          },
        ],
      }),
    );
    const { GET } = await import("@/app/api/cron/retention/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("12 Main St");
    expect(body).not.toContain("task_description");
  });

  it("surfaces failures rather than reporting a clean sweep", async () => {
    mockPrune.mockResolvedValue(
      summary({ failed: [{ payment_request_id: "pr_9", error: "rpc exploded" }] }),
    );
    const { GET } = await import("@/app/api/cron/retention/route");

    const json = await (await GET(makeRequest(`Bearer ${SECRET}`))).json();
    expect(json.failed).toBe(1);
    expect(json.failures).toEqual(["pr_9"]);
    // The error text stays in the server log, not the response.
    expect(JSON.stringify(json)).not.toContain("rpc exploded");
  });

  it("does not leak the engine's error message when the sweep throws", async () => {
    mockPrune.mockRejectedValue(new Error("connection string: postgres://user:pw@host"));
    const { GET } = await import("@/app/api/cron/retention/route");

    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await res.json())).not.toContain("postgres://");
  });
});
