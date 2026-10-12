import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

/**
 * syncSettledTasks (CC-080) — the observer that moves a funded row to
 * `completed`/`expired` once the chain says the money has moved.
 *
 * The escrow reads are mocked; the DB writes go through the real
 * updateTaskStatus against a mocked client, so VALID_TRANSITIONS and its
 * WHERE-status guard are exercised rather than assumed.
 */

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: mockFrom }),
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

const mockGetOnChainTask = vi.fn();
const mockGetTaskResolvedOutcome = vi.fn();
let mockEscrowAddress: string | null;
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
  getTaskResolvedOutcome: (...args: unknown[]) => mockGetTaskResolvedOutcome(...args),
  getEscrowConfig: () => ({
    address: mockEscrowAddress,
    chainId: 84532,
    chainName: "Base Sepolia",
    usdcDecimals: 6,
  }),
}));

import {
  settlementTargetFor,
  syncSettledTasks,
  SETTLEMENT_SYNC_BATCH_LIMIT,
  SETTLEMENT_SYNC_OUTCOME_BUDGET_MS,
} from "@/lib/db/settlement-sync";

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.update = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.in = vi.fn(self);
  chain.ilike = vi.fn(self);
  chain.order = vi.fn(self);
  chain.limit = vi.fn(self);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)));
  return chain;
}

/** Lowercase in the DB (migration 014), checksummed from the chain. */
const WORKER = "0xabcdefabcdefabcdefabcdefabcdefabcdef1234";
const WORKER_CHECKSUMMED = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdef1234";
const OTHER_WORKER = "0x1111111111111111111111111111111111111111";

/** The escrow this deployment reads, and one a redeploy superseded. */
const ESCROW = "0xc6aa99a8226b679C71945dd9545685896a91E4d3";
const OLD_ESCROW = "0xe80d000000000000000000000000000000CB1b1";

function row(over: Record<string, unknown> = {}) {
  return {
    payment_request_id: "pr_1",
    status: "active",
    to_human_wallet: WORKER,
    amount_usdc: 25,
    escrow_contract: ESCROW,
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function onChain(state: string, over: Record<string, unknown> = {}) {
  return { state, worker: WORKER_CHECKSUMMED, amount: BigInt(25_000_000), ...over };
}

/** Per-id chain state; an Error value makes that id's read reject. */
function chainSays(byId: Record<string, unknown>) {
  mockGetOnChainTask.mockImplementation(async (id: string) => {
    const v = byId[id];
    if (v instanceof Error) throw v;
    return v;
  });
}

const WRITE_OK = (id = "pr_1") => ({ data: [{ payment_request_id: id }], error: null });

/**
 * Queue the candidate read, then one chain per subsequent .from() — the
 * updateTaskStatus write, plus its diagnostic lookup when the write misses.
 */
function queue(candidates: unknown[], ...later: { data: unknown; error: unknown }[]) {
  const candidateChain = chainable({ data: candidates, error: null });
  mockFrom.mockReturnValueOnce(candidateChain);
  const laterChains = later.map((r) => chainable(r));
  for (const c of laterChains) mockFrom.mockReturnValueOnce(c);
  return { candidateChain, laterChains };
}

let consoleSpy: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  mockFrom.mockReset();
  mockEscrowAddress = ESCROW;
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  vi.useRealTimers();
});

function loggedEvents(event: string): Record<string, unknown>[] {
  return consoleSpy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === "string")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === event);
}

function allLogText(): string {
  return consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("settlementTargetFor", () => {
  it.each(["active", "disputed"] as const)("Completed → completed from %s", (status) => {
    expect(settlementTargetFor(status, "Completed")).toBe("completed");
  });

  it.each(["active", "disputed"] as const)("Expired → expired from %s", (status) => {
    expect(settlementTargetFor(status, "Expired")).toBe("expired");
  });

  it("Resolved defers to the TaskResolved event", () => {
    expect(settlementTargetFor("active", "Resolved")).toBe("resolved");
    expect(settlementTargetFor("disputed", "Resolved")).toBe("resolved");
  });

  it.each(["Disputed", "Arbitrating"] as const)(
    "%s moves an active row to disputed and leaves a disputed row alone",
    (state) => {
      expect(settlementTargetFor("active", state)).toBe("disputed");
      expect(settlementTargetFor("disputed", state)).toBeNull();
    },
  );

  it.each(["None", "Funded", "Delivered"] as const)("%s is still in flight — no change", (state) => {
    expect(settlementTargetFor("active", state)).toBeNull();
    expect(settlementTargetFor("disputed", state)).toBeNull();
  });
});

describe("syncSettledTasks", () => {
  it("reads only in-flight rows on this escrow, oldest updated first, bounded, and never selects content", async () => {
    const { candidateChain } = queue([]);

    const summary = await syncSettledTasks();

    // Terminal and pre-funding rows are never candidates — the query is the
    // first guard, updateTaskStatus's WHERE-status clause the second.
    expect(candidateChain.in).toHaveBeenCalledWith("status", ["active", "disputed"]);
    // Nor are rows funded on any other escrow. Case-insensitive: the column
    // holds whatever casing the env var had when the row was created.
    expect(candidateChain.ilike).toHaveBeenCalledWith("escrow_contract", ESCROW);
    expect(candidateChain.order).toHaveBeenCalledWith("updated_at", { ascending: true });
    expect(candidateChain.limit).toHaveBeenCalledWith(SETTLEMENT_SYNC_BATCH_LIMIT);
    const selected = String(candidateChain.select.mock.calls[0][0]);
    expect(selected).toContain("escrow_contract");
    expect(selected).not.toContain("task_description");
    expect(selected).not.toContain("acceptance_spec");

    expect(mockGetOnChainTask).not.toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ considered: 0, updated: [], unchanged: 0, failed: [] });
  });

  it("moves an active row the chain reports Completed to completed", async () => {
    const { laterChains } = queue([row()], WRITE_OK());
    chainSays({ pr_1: onChain("Completed") });

    const summary = await syncSettledTasks();

    const write = laterChains[0];
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(write.eq).toHaveBeenCalledWith("payment_request_id", "pr_1");
    expect(write.in).toHaveBeenCalledWith("status", ["active", "disputed"]);
    expect(summary.updated).toEqual([
      { payment_request_id: "pr_1", from: "active", to: "completed", on_chain_state: "Completed" },
    ]);
    expect(loggedEvents("task_settlement_synced")).toHaveLength(1);
  });

  it("moves a disputed row to completed when the worker claimed after the arbitration window", async () => {
    // releaseAfterArbitration pays through _payOut, which lands in Completed, not Resolved.
    const { laterChains } = queue([row({ status: "disputed" })], WRITE_OK());
    chainSays({ pr_1: onChain("Completed") });

    const summary = await syncSettledTasks();

    expect(laterChains[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(summary.updated[0]).toMatchObject({ from: "disputed", to: "completed" });
  });

  it("records a funded task the agent reclaimed: active → expired", async () => {
    // The transition VALID_TRANSITIONS lacked: expireTask is only reachable
    // from Funded, so an Expired task's row is always still `active`.
    const { laterChains } = queue([row()], WRITE_OK());
    chainSays({ pr_1: onChain("Expired") });

    const summary = await syncSettledTasks();

    const write = laterChains[0];
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }));
    const allowedFrom = write.in.mock.calls[0][1] as string[];
    expect(allowedFrom).toContain("active");
    expect(summary.updated).toEqual([
      { payment_request_id: "pr_1", from: "active", to: "expired", on_chain_state: "Expired" },
    ]);
  });

  it("maps Resolved in the worker's favour to completed", async () => {
    const { laterChains } = queue([row({ status: "disputed" })], WRITE_OK());
    chainSays({ pr_1: onChain("Resolved") });
    mockGetTaskResolvedOutcome.mockResolvedValue({ releasedToWorker: true, amount: BigInt(25_000_000) });

    const summary = await syncSettledTasks();

    expect(mockGetTaskResolvedOutcome).toHaveBeenCalledWith("pr_1");
    expect(laterChains[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(summary.updated[0]).toMatchObject({ to: "completed", on_chain_state: "Resolved" });
  });

  it("maps Resolved in the agent's favour to expired", async () => {
    const { laterChains } = queue([row({ status: "disputed" })], WRITE_OK());
    chainSays({ pr_1: onChain("Resolved") });
    mockGetTaskResolvedOutcome.mockResolvedValue({ releasedToWorker: false, amount: BigInt(25_000_000) });

    const summary = await syncSettledTasks();

    expect(laterChains[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
    );
    expect(summary.updated[0]).toMatchObject({ to: "expired", on_chain_state: "Resolved" });
  });

  it("leaves a Resolved row alone, and says so, when the TaskResolved event cannot be found", async () => {
    queue([row({ status: "disputed" })]);
    chainSays({ pr_1: onChain("Resolved") });
    mockGetTaskResolvedOutcome.mockResolvedValue(null);

    const summary = await syncSettledTasks();

    // Guessing a direction would be the DB inventing a payout. No write at all.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(summary.outcome_missing).toEqual(["pr_1"]);
    expect(summary.updated).toEqual([]);
    expect(loggedEvents("settlement_sync_resolved_outcome_missing")).toHaveLength(1);
  });

  it("counts a failed TaskResolved lookup without writing", async () => {
    queue([row({ status: "disputed" })]);
    chainSays({ pr_1: onChain("Resolved") });
    mockGetTaskResolvedOutcome.mockRejectedValue(new Error("eth_getLogs range too large"));

    const summary = await syncSettledTasks();

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(summary.failed).toEqual([
      { payment_request_id: "pr_1", stage: "outcome", error: "eth_getLogs range too large" },
    ]);
  });

  it.each(["Disputed", "Arbitrating"])(
    "moves an active row to disputed when the chain says %s",
    async (state) => {
      const { laterChains } = queue([row()], WRITE_OK());
      chainSays({ pr_1: onChain(state) });

      const summary = await syncSettledTasks();

      expect(laterChains[0].update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "disputed" }),
      );
      expect(summary.updated[0]).toMatchObject({ from: "active", to: "disputed" });
    },
  );

  it.each([
    ["active", "Funded"],
    ["active", "Delivered"],
    ["active", "None"],
    ["disputed", "Disputed"],
    ["disputed", "Arbitrating"],
  ])("leaves a %s row alone while the chain says %s", async (status, state) => {
    queue([row({ status })]);
    chainSays({ pr_1: onChain(state) });

    const summary = await syncSettledTasks();

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.updated).toEqual([]);
  });

  it("does not abort the batch when one row's chain read fails", async () => {
    // viem's full message carries the RPC URL — and a provider key can sit in
    // its path. The short message is what reaches the log.
    const rpcError = Object.assign(
      new Error("HTTP request failed.\n\nURL: https://base-sepolia.example/v2/sekret-key"),
      { shortMessage: "HTTP request failed." },
    );
    const { laterChains } = queue(
      [row({ payment_request_id: "pr_1" }), row({ payment_request_id: "pr_2" })],
      WRITE_OK("pr_2"),
    );
    chainSays({ pr_1: rpcError, pr_2: onChain("Completed") });

    const summary = await syncSettledTasks();

    expect(summary.considered).toBe(2);
    expect(summary.failed).toEqual([
      { payment_request_id: "pr_1", stage: "read", error: "HTTP request failed." },
    ]);
    expect(summary.updated).toEqual([
      { payment_request_id: "pr_2", from: "active", to: "completed", on_chain_state: "Completed" },
    ]);
    expect(laterChains[0].eq).toHaveBeenCalledWith("payment_request_id", "pr_2");
    expect(loggedEvents("settlement_sync_row_failed")).toHaveLength(1);
    expect(allLogText()).not.toContain("sekret-key");
  });

  it.each([
    ["a duplicate cron delivery", "Completed", "completed"],
    ["the dispute route", "Disputed", "disputed"],
  ])(
    "counts a row %s already moved to the target as unchanged, not failed, and carries on",
    async (_, state, target) => {
      // The atomic WHERE-status guard in updateTaskStatus refuses the no-op;
      // the row already says what the chain says, so there is nothing to report.
      const { laterChains } = queue(
        [row({ payment_request_id: "pr_1" }), row({ payment_request_id: "pr_2" })],
        { data: [], error: null }, // pr_1 write matches nothing
        { data: { status: target }, error: null }, // updateTaskStatus's diagnostic lookup
        { data: { status: target }, error: null }, // the sync's re-read
        WRITE_OK("pr_2"),
      );
      chainSays({ pr_1: onChain(state), pr_2: onChain("Expired") });

      const summary = await syncSettledTasks();

      expect(summary.failed).toEqual([]);
      expect(summary.unchanged).toBe(1);
      expect(loggedEvents("settlement_sync_row_failed")).toEqual([]);
      expect(laterChains[3].update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "expired" }),
      );
      expect(summary.updated.map((t) => t.payment_request_id)).toEqual(["pr_2"]);
    },
  );

  it("fails a refused write when the row moved somewhere other than the target, and carries on", async () => {
    // The chain says Completed but the row is now `expired`: the DB and the
    // chain disagree about money, which is a failure worth surfacing.
    const { laterChains } = queue(
      [row({ payment_request_id: "pr_1" }), row({ payment_request_id: "pr_2" })],
      { data: [], error: null }, // pr_1 write matches nothing
      { data: { status: "expired" }, error: null }, // updateTaskStatus's diagnostic lookup
      { data: { status: "expired" }, error: null }, // the sync's re-read
      WRITE_OK("pr_2"),
    );
    chainSays({ pr_1: onChain("Completed"), pr_2: onChain("Expired") });

    const summary = await syncSettledTasks();

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ payment_request_id: "pr_1", stage: "write" });
    expect(summary.failed[0].error).toContain("Invalid state transition: expired → completed");
    expect(laterChains[3].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
    );
    expect(summary.updated.map((t) => t.payment_request_id)).toEqual(["pr_2"]);
  });

  it.each([
    ["a superseded escrow", OLD_ESCROW],
    ["no recorded escrow", null],
  ])("never judges a row from %s by this escrow's state", async (_, escrowContract) => {
    // The cutover attack: the row is live on the old escrow, and anyone can
    // read its id, worker and amount from tasks_public, create a matching task
    // on the new escrow and expire it. That reading must not reach the row.
    queue([row({ escrow_contract: escrowContract })]);
    chainSays({ pr_1: onChain("Expired") }); // matching worker and amount

    const summary = await syncSettledTasks();

    expect(mockGetOnChainTask).not.toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledTimes(1); // no write
    expect(summary.updated).toEqual([]);
    expect(summary.mismatched).toEqual(["pr_1"]);
    expect(loggedEvents("settlement_sync_escrow_mismatch")).toHaveLength(1);
  });

  it("matches the row's escrow case-insensitively", async () => {
    const { laterChains } = queue([row({ escrow_contract: ESCROW.toLowerCase() })], WRITE_OK());
    chainSays({ pr_1: onChain("Completed") });

    const summary = await syncSettledTasks();

    expect(laterChains[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(summary.mismatched).toEqual([]);
  });

  it.each(["completed", "expired", "lapsed", "declined", "pending", "accepted"])(
    "ignores a %s row the query returned anyway: no read, no write",
    async (status) => {
      // The query filters these out; a mock that does no filtering stands in
      // for a filter that silently stopped applying.
      queue([row({ status })]);
      chainSays({ pr_1: onChain("Expired") });

      const summary = await syncSettledTasks();

      expect(mockGetOnChainTask).not.toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(summary.updated).toEqual([]);
      expect(summary.unchanged).toBe(1);
    },
  );

  it("writes every other row before starting a TaskResolved lookup", async () => {
    const { laterChains } = queue(
      [row({ payment_request_id: "pr_1", status: "disputed" }), row({ payment_request_id: "pr_2" })],
      WRITE_OK("pr_2"),
      WRITE_OK("pr_1"),
    );
    chainSays({ pr_1: onChain("Resolved"), pr_2: onChain("Completed") });
    let writesBeforeLookup = -1;
    mockGetTaskResolvedOutcome.mockImplementation(async () => {
      writesBeforeLookup = laterChains[0].update.mock.calls.length;
      return { releasedToWorker: true, amount: BigInt(25_000_000) };
    });

    const summary = await syncSettledTasks();

    expect(writesBeforeLookup).toBe(1);
    expect(laterChains[0].eq).toHaveBeenCalledWith("payment_request_id", "pr_2");
    expect(summary.updated.map((t) => t.payment_request_id)).toEqual(["pr_2", "pr_1"]);
  });

  it("stops starting TaskResolved lookups once the time budget is spent, and defers the rest", async () => {
    // A lookup that walks weeks of chain can outlast the cron's maxDuration.
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-12T00:00:00.000Z");
    vi.setSystemTime(startedAt);

    queue(
      [
        row({ payment_request_id: "pr_1", status: "disputed" }),
        row({ payment_request_id: "pr_2", status: "disputed" }),
        row({ payment_request_id: "pr_3" }),
      ],
      WRITE_OK("pr_3"),
      WRITE_OK("pr_1"),
    );
    chainSays({
      pr_1: onChain("Resolved"),
      pr_2: onChain("Resolved"),
      pr_3: onChain("Expired"),
    });
    mockGetTaskResolvedOutcome.mockImplementation(async () => {
      vi.setSystemTime(startedAt + SETTLEMENT_SYNC_OUTCOME_BUDGET_MS);
      return { releasedToWorker: false, amount: BigInt(25_000_000) };
    });

    const summary = await syncSettledTasks();

    expect(mockGetTaskResolvedOutcome).toHaveBeenCalledTimes(1);
    expect(mockGetTaskResolvedOutcome).toHaveBeenCalledWith("pr_1");
    expect(summary.updated.map((t) => [t.payment_request_id, t.to])).toEqual([
      ["pr_3", "expired"],
      ["pr_1", "expired"],
    ]);
    expect(summary.deferred).toEqual(["pr_2"]);
    expect(summary.failed).toEqual([]);
    expect(loggedEvents("settlement_sync_outcome_lookups_deferred")).toHaveLength(1);
  });

  it.each([
    ["worker", { worker: OTHER_WORKER }],
    ["amount", { amount: BigInt(1) }],
  ])("refuses to project a settlement whose on-chain %s disagrees with the row", async (_, over) => {
    queue([row({ status: "disputed" })]);
    chainSays({ pr_1: onChain("Resolved", over) });

    const summary = await syncSettledTasks();

    expect(mockFrom).toHaveBeenCalledTimes(1);
    // Checked before the event lookup, so a mismatch costs no log scan.
    expect(mockGetTaskResolvedOutcome).not.toHaveBeenCalled();
    expect(summary.mismatched).toEqual(["pr_1"]);
    expect(summary.updated).toEqual([]);
    expect(loggedEvents("settlement_sync_chain_mismatch")).toHaveLength(1);
  });

  it("never logs a wallet address in full, from any of its log sites", async () => {
    // One row down every branch that logs, with the wallets in scope at each,
    // so a field added to any of those lines later is caught here.
    queue(
      [
        row({ payment_request_id: "pr_ok" }),
        row({ payment_request_id: "pr_mismatch" }),
        row({ payment_request_id: "pr_read" }),
        row({ payment_request_id: "pr_write" }),
        row({ payment_request_id: "pr_missing", status: "disputed" }),
        row({ payment_request_id: "pr_outcome", status: "disputed" }),
        row({ payment_request_id: "pr_old", escrow_contract: OLD_ESCROW }),
      ],
      WRITE_OK("pr_ok"),
      { data: null, error: { message: "permission denied" } }, // pr_write
    );
    chainSays({
      pr_ok: onChain("Completed"),
      pr_mismatch: onChain("Completed", { worker: OTHER_WORKER }),
      pr_read: new Error("decode failed"),
      pr_write: onChain("Completed"),
      pr_missing: onChain("Resolved"),
      pr_outcome: onChain("Resolved"),
    });
    mockGetTaskResolvedOutcome.mockImplementation(async (id: string) => {
      if (id === "pr_outcome") throw new Error("eth_getLogs range too large");
      return null;
    });

    await syncSettledTasks();

    for (const event of [
      "task_settlement_synced",
      "settlement_sync_chain_mismatch",
      "settlement_sync_row_failed",
      "settlement_sync_resolved_outcome_missing",
      "settlement_sync_escrow_mismatch",
      "settlement_sync_run",
    ]) {
      expect(loggedEvents(event).length, event).toBeGreaterThan(0);
    }
    expect(loggedEvents("settlement_sync_row_failed").map((e) => e.stage)).toEqual(
      expect.arrayContaining(["read", "write", "outcome"]),
    );
    const text = allLogText().toLowerCase();
    expect(text).not.toContain(WORKER);
    expect(text).not.toContain(OTHER_WORKER);
  });

  it("fails the run once, before reading anything, when the escrow is not configured", async () => {
    mockEscrowAddress = null;

    await expect(syncSettledTasks()).rejects.toThrow("escrow contract is not configured");
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });

  it("fails the run before reading anything when the escrow address is malformed", async () => {
    // The address is used as an ilike pattern; only a hex address makes that equality.
    mockEscrowAddress = "0x%";

    await expect(syncSettledTasks()).rejects.toThrow("escrow contract address is malformed");
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });

  it("throws when the candidate read fails", async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: { message: "connection refused" } }));

    await expect(syncSettledTasks()).rejects.toThrow("syncSettledTasks failed: connection refused");
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });

  it("emits one run summary with the counts", async () => {
    queue(
      [
        row({ payment_request_id: "pr_1" }),
        row({ payment_request_id: "pr_2" }),
        row({ payment_request_id: "pr_3" }),
      ],
      WRITE_OK("pr_1"),
    );
    chainSays({
      pr_1: onChain("Completed"),
      pr_2: onChain("Delivered"),
      pr_3: new Error("decode failed"),
    });

    await syncSettledTasks();

    expect(loggedEvents("settlement_sync_run")).toEqual([
      expect.objectContaining({
        considered: 3,
        updated: 1,
        unchanged: 1,
        mismatched: 0,
        outcome_missing: 0,
        deferred: 0,
        failed: 1,
      }),
    ]);
  });
});
