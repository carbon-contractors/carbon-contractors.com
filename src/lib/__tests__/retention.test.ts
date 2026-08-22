import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

// Mock Supabase client — the retention engine is admin-only (it prunes rows),
// so everything goes through mockFrom. The prune RPC is called on the client
// itself (supabase.rpc), not through .from(), so it gets its own mock.
const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}));

// Stub config env (same set as tasks.test.ts)
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import {
  RETENTION_RULE_VERSION,
  TERMINAL_STATUSES,
  DISPUTE_WINDOW_SECONDS,
  isPruneEligible,
  pruneExpiredTaskContent,
} from "@/lib/db/retention";

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.insert = vi.fn(self);
  chain.update = vi.fn(self);
  chain.delete = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.in = vi.fn(self);
  chain.is = vi.fn(self);
  chain.lt = vi.fn(self);
  chain.order = vi.fn(self);
  chain.limit = vi.fn(self);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.rpc = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)));
  return chain;
}

const NOW = 1_800_000_000;
const isoAt = (unix: number) => new Date(unix * 1000).toISOString();
/** updated_at placing a task DISPUTE_WINDOW_SECONDS (+ slack) in the past. */
const PAST_TERMINAL_AT = isoAt(NOW - DISPUTE_WINDOW_SECONDS - 3600);
/** updated_at placing a task just inside the window. */
const RECENT_TERMINAL_AT = isoAt(NOW - 3600);

let consoleSpy: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

/** Capture the parsed JSON lines the logger emitted for a given event. */
function loggedEvents(event: string): Record<string, unknown>[] {
  return consoleSpy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === "string")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === event);
}

describe("isPruneEligible", () => {
  it.each(["pending", "active", "disputed"] as const)(
    "never prunes a non-terminal task (%s), however old",
    (status) => {
      expect(
        isPruneEligible(
          { status, updated_at: PAST_TERMINAL_AT, content_purged_at: null },
          NOW,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "expired"] as const)(
    "prunes a terminal task (%s) past the dispute window",
    (status) => {
      expect(
        isPruneEligible(
          { status, updated_at: PAST_TERMINAL_AT, content_purged_at: null },
          NOW,
        ),
      ).toBe(true);
    },
  );

  it("does not prune a terminal task before the dispute window has elapsed", () => {
    for (const status of ["completed", "expired"] as const) {
      expect(
        isPruneEligible(
          { status, updated_at: RECENT_TERMINAL_AT, content_purged_at: null },
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("prunes exactly at the window boundary, not one second before", () => {
    const boundary = isoAt(NOW - DISPUTE_WINDOW_SECONDS);
    const task = { status: "completed" as const, updated_at: boundary, content_purged_at: null };
    expect(isPruneEligible(task, NOW)).toBe(true);
    expect(isPruneEligible(task, NOW - 1)).toBe(false);
  });

  it("never prunes an already-purged task (idempotence)", () => {
    expect(
      isPruneEligible(
        {
          status: "completed",
          updated_at: PAST_TERMINAL_AT,
          content_purged_at: "2026-08-10T00:00:00Z",
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("fails safe on an unparseable updated_at", () => {
    expect(
      isPruneEligible(
        { status: "expired", updated_at: "not-a-timestamp", content_purged_at: null },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("pruneExpiredTaskContent", () => {
  function seedCandidates(rows: unknown[], rpcResults?: unknown[]) {
    const queryChain = chainable({ data: rows, error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === "tasks") return queryChain;
      return chainable({ data: null, error: null });
    });
    let rpcCall = 0;
    mockRpc.mockImplementation(() =>
      Promise.resolve(
        rpcResults
          ? (rpcResults[rpcCall++] ?? { data: null, error: null })
          : { data: { pruned: true, payment_request_id: "pr", deleted_at: "2026-08-22T00:00:00Z" }, error: null },
      ),
    );
    return queryChain;
  }

  it("selects only terminal, unpurged tasks older than the cutoff — and never selects content columns", async () => {
    const chain = seedCandidates([]);

    await pruneExpiredTaskContent(NOW);

    expect(mockFrom).toHaveBeenCalledWith("tasks");
    // The SELECT list is data minimisation at the query level: no
    // task_description, no acceptance_spec (ADR-0002 D9's log trap applies to
    // the engine's own reads too).
    expect(chain.select).toHaveBeenCalledWith(
      "id,payment_request_id,status,updated_at,content_purged_at",
    );
    expect(chain.in).toHaveBeenCalledWith("status", [...TERMINAL_STATUSES]);
    expect(chain.is).toHaveBeenCalledWith("content_purged_at", null);
    expect(chain.lt).toHaveBeenCalledWith(
      "updated_at",
      new Date((NOW - DISPUTE_WINDOW_SECONDS) * 1000).toISOString(),
    );
  });

  it("prunes eligible tasks via the RPC and never issues a direct column update", async () => {
    const rows = [
      { id: "t1", payment_request_id: "pr_1", status: "completed", updated_at: PAST_TERMINAL_AT, content_purged_at: null },
      { id: "t2", payment_request_id: "pr_2", status: "expired", updated_at: PAST_TERMINAL_AT, content_purged_at: null },
    ];
    const chain = seedCandidates(
      rows,
      rows.map((r, i) => ({
        data: { pruned: true, payment_request_id: r.payment_request_id, deleted_at: `2026-08-2${i + 1}T00:00:00Z` },
        error: null,
      })),
    );

    const summary = await pruneExpiredTaskContent(NOW);

    expect(mockRpc).toHaveBeenCalledTimes(2);
    for (const row of rows) {
      expect(mockRpc).toHaveBeenCalledWith("prune_task_content", {
        p_task_id: row.id,
        p_rule_version: RETENTION_RULE_VERSION,
        p_window_seconds: DISPUTE_WINDOW_SECONDS,
      });
    }
    expect(summary.pruned.map((p) => p.payment_request_id)).toEqual(["pr_1", "pr_2"]);
    // The engine must not touch columns itself: hashes and on-chain references
    // are preserved because the only write path is the RPC, whose UPDATE
    // (migration 019) never touches spec_hash, wallets, amount or timestamps.
    expect(chain.update).not.toHaveBeenCalled();
    expect(chain.delete).not.toHaveBeenCalled();
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it("emits a task_content_pruned event per pruned task with id, rule version and deleted_at", async () => {
    seedCandidates(
      [{ id: "t1", payment_request_id: "pr_1", status: "completed", updated_at: PAST_TERMINAL_AT, content_purged_at: null }],
      [{ data: { pruned: true, payment_request_id: "pr_1", deleted_at: "2026-08-22T00:00:00Z" }, error: null }],
    );

    await pruneExpiredTaskContent(NOW);

    const events = loggedEvents("task_content_pruned");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      level: "info",
      event: "task_content_pruned",
      ts: expect.any(Number),
      payment_request_id: "pr_1",
      retention_rule_version: RETENTION_RULE_VERSION,
      deleted_at: "2026-08-22T00:00:00Z",
    });
  });

  it("leaks no deleted content into any log line", async () => {
    const description = "go to 42 Smith St and ask for Dave about the silver hatchback";
    const spec = '{"schema_version":1,"criteria":[{"type":"photo","gps":[-33.8,151.2]}]}';
    const evidenceUrl = "https://bucket.example.com/evidence/pr_1";
    // The mock rows carry content they should never have delivered — if the
    // engine ever widens its SELECT or its log meta, this test trips.
    seedCandidates(
      [{
        id: "t1",
        payment_request_id: "pr_1",
        status: "completed",
        updated_at: PAST_TERMINAL_AT,
        content_purged_at: null,
        task_description: description,
        acceptance_spec: spec,
        evidence_url: evidenceUrl,
      }],
      [{ data: { pruned: true, payment_request_id: "pr_1", deleted_at: "2026-08-22T00:00:00Z" }, error: null }],
    );

    await pruneExpiredTaskContent(NOW);

    const allLogs = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).not.toContain("Smith St");
    expect(allLogs).not.toContain("Dave");
    expect(allLogs).not.toContain(spec);
    expect(allLogs).not.toContain(evidenceUrl);
  });

  it("skips candidates the RPC reports as already pruned, without an event", async () => {
    seedCandidates(
      [{ id: "t1", payment_request_id: "pr_1", status: "completed", updated_at: PAST_TERMINAL_AT, content_purged_at: null }],
      [{ data: { pruned: false, reason: "already_purged" }, error: null }],
    );

    const summary = await pruneExpiredTaskContent(NOW);

    expect(summary.pruned).toHaveLength(0);
    expect(summary.skipped).toEqual([
      { payment_request_id: "pr_1", pruned: false, reason: "already_purged" },
    ]);
    expect(loggedEvents("task_content_pruned")).toHaveLength(0);
  });

  it("records an RPC failure and continues pruning the rest of the batch", async () => {
    seedCandidates(
      [
        { id: "t1", payment_request_id: "pr_1", status: "completed", updated_at: PAST_TERMINAL_AT, content_purged_at: null },
        { id: "t2", payment_request_id: "pr_2", status: "expired", updated_at: PAST_TERMINAL_AT, content_purged_at: null },
      ],
      [
        { data: null, error: { message: "concurrent update", code: "23505" } },
        { data: { pruned: true, payment_request_id: "pr_2", deleted_at: "2026-08-22T00:00:00Z" }, error: null },
      ],
    );

    const summary = await pruneExpiredTaskContent(NOW);

    expect(summary.failed).toEqual([
      { payment_request_id: "pr_1", error: "concurrent update" },
    ]);
    expect(summary.pruned.map((p) => p.payment_request_id)).toEqual(["pr_2"]);
    const failures = loggedEvents("task_content_prune_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ payment_request_id: "pr_1", error: "concurrent update" });
  });

  it("emits one task_retention_enforced summary event per run, even with nothing to do", async () => {
    seedCandidates([]);

    const summary = await pruneExpiredTaskContent(NOW);

    expect(summary.considered).toBe(0);
    const events = loggedEvents("task_retention_enforced");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      retention_rule_version: RETENTION_RULE_VERSION,
      considered: 0,
      pruned: 0,
      skipped: 0,
      failed: 0,
      cutoff: new Date((NOW - DISPUTE_WINDOW_SECONDS) * 1000).toISOString(),
    });
  });

  it("re-checks eligibility locally and skips a row that slipped past the query filter", async () => {
    seedCandidates([
      // status says pending even though the query filtered — a bug or a race.
      { id: "t1", payment_request_id: "pr_1", status: "pending", updated_at: PAST_TERMINAL_AT, content_purged_at: null },
    ]);

    const summary = await pruneExpiredTaskContent(NOW);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual([
      { payment_request_id: "pr_1", pruned: false, reason: "ineligible_at_engine" },
    ]);
  });

  it("throws when the candidate query itself fails", async () => {
    mockFrom.mockReturnValue(
      chainable({ data: null, error: { message: "connection failed", code: "500" } }),
    );

    await expect(pruneExpiredTaskContent(NOW)).rejects.toThrow(
      "pruneExpiredTaskContent failed",
    );
  });
});
