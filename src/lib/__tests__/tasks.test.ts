import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Supabase client (reads use anon, writes use admin — both share mockFrom;
// mockFromAnon distinguishes which client a CC-093 read goes through)
const mockFrom = vi.fn();
const mockFromAnon = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabase: () => ({ from: mockFromAnon }),
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

// Stub config env
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_ANON_KEY", "key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
vi.stubEnv("NEXT_PUBLIC_BASE_NETWORK", "testnet");
vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

import { getTaskByPaymentId, updateTaskStatus, markTaskFunded, getReputationSummary, createTask, getTasksByWallet, getTasksForParties, getPublicTasks, lapseExpiredOffers, countCommittedTasks, WORKER_CONCURRENCY_CAP } from "@/lib/db/tasks";

function chainable(result: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  // Every method returns the chain itself, and the chain is thenable
  // so awaiting at any point resolves to `result`.
  chain.select = vi.fn(self);
  chain.insert = vi.fn(self);
  chain.update = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.in = vi.fn(self);
  chain.not = vi.fn(self);
  chain.lte = vi.fn(self);
  chain.order = vi.fn(self);
  chain.limit = vi.fn(self);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)));
  return chain;
}

describe("tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getTaskByPaymentId returns task when found", async () => {
    const task = { id: "1", payment_request_id: "abc", status: "active" };
    const chain = chainable({ data: task, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await getTaskByPaymentId("abc");
    expect(result).toEqual(task);
    expect(mockFrom).toHaveBeenCalledWith("tasks");
  });

  it("getTaskByPaymentId returns null when not found", async () => {
    const chain = chainable({
      data: null,
      error: { message: "not found", code: "PGRST116" },
    });
    mockFrom.mockReturnValue(chain);

    const result = await getTaskByPaymentId("nonexistent");
    expect(result).toBeNull();
  });

  it("getTaskByPaymentId throws on real errors", async () => {
    const chain = chainable({
      data: null,
      error: { message: "connection failed", code: "500" },
    });
    mockFrom.mockReturnValue(chain);

    await expect(getTaskByPaymentId("abc")).rejects.toThrow(
      "getTaskByPaymentId failed"
    );
  });

  it("updateTaskStatus calls update with correct args", async () => {
    // Atomic update: .update().eq().in().select() returns matched row
    const updateChain = chainable({ data: [{ payment_request_id: "abc" }], error: null });
    mockFrom.mockReturnValueOnce(updateChain);

    await updateTaskStatus("abc", "completed");
    expect(mockFrom).toHaveBeenCalledWith("tasks");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    );
    expect(updateChain.in).toHaveBeenCalledWith("status", ["active", "disputed"]);
  });

  it("updateTaskStatus rejects invalid state transitions", async () => {
    // Atomic update returns no rows (status didn't match allowed sources)
    const updateChain = chainable({ data: [], error: null });
    // Fallback lookup returns current status
    const lookupChain = chainable({ data: { status: "completed" }, error: null });
    mockFrom
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(lookupChain);

    await expect(updateTaskStatus("abc", "active")).rejects.toThrow(
      "Invalid state transition: completed → active (allowed from: accepted)"
    );
  });

  it("markTaskFunded sets status active and funded_at from a unix timestamp, gated on accepted", async () => {
    const updateChain = chainable({ data: [{ payment_request_id: "abc" }], error: null });
    mockFrom.mockReturnValueOnce(updateChain);

    await markTaskFunded("abc", 1_700_000_000);

    expect(mockFrom).toHaveBeenCalledWith("tasks");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        funded_at: new Date(1_700_000_000 * 1000).toISOString(),
      }),
    );
    expect(updateChain.eq).toHaveBeenCalledWith("status", "accepted");
  });

  it("markTaskFunded throws when the task is not accepted", async () => {
    const updateChain = chainable({ data: [], error: null });
    const lookupChain = chainable({ data: { status: "pending" }, error: null });
    mockFrom.mockReturnValueOnce(updateChain).mockReturnValueOnce(lookupChain);

    await expect(markTaskFunded("abc", 1_700_000_000)).rejects.toThrow(
      "Invalid state transition: pending → active (allowed from: accepted)",
    );
  });

  it("markTaskFunded throws when the task does not exist", async () => {
    const updateChain = chainable({ data: [], error: null });
    const lookupChain = chainable({ data: null, error: null });
    mockFrom.mockReturnValueOnce(updateChain).mockReturnValueOnce(lookupChain);

    await expect(markTaskFunded("nonexistent", 1_700_000_000)).rejects.toThrow(
      "Task not found: nonexistent",
    );
  });

  // ─── CC-094 / ADR-0005: the offer lifecycle ──────────────────────────────

  it("moves a task to active only from accepted — never straight from pending (ADR-0005 D2)", async () => {
    const updateChain = chainable({ data: [{ payment_request_id: "abc" }], error: null });
    mockFrom.mockReturnValueOnce(updateChain);

    await updateTaskStatus("abc", "active");

    expect(updateChain.in).toHaveBeenCalledWith("status", ["accepted"]);
  });

  it("allows pending → accepted / declined / lapsed (ADR-0005 D2/D4/D6)", async () => {
    for (const target of ["accepted", "declined", "lapsed"] as const) {
      const updateChain = chainable({ data: [{ payment_request_id: "abc" }], error: null });
      mockFrom.mockReturnValueOnce(updateChain);
      await updateTaskStatus("abc", target);
      // 'lapsed' may also come from 'accepted' (agent never funded); every
      // offer decision starts from 'pending'.
      expect(updateChain.in).toHaveBeenCalledWith("status", expect.arrayContaining(["pending"]));
    }
  });

  it("treats declined and lapsed as terminal — nothing may transition from them", async () => {
    // No target state lists 'declined' or 'lapsed' as an allowed source.
    const updateChain = chainable({ data: [], error: null });
    const lookupChain = chainable({ data: { status: "declined" }, error: null });
    mockFrom.mockReturnValueOnce(updateChain).mockReturnValueOnce(lookupChain);

    await expect(updateTaskStatus("abc", "accepted")).rejects.toThrow(
      "Invalid state transition: declined → accepted (allowed from: pending)",
    );
  });

  it("createTask persists the offer-stage status and expiry (CC-094)", async () => {
    const chain = chainable({ data: { id: "1", payment_request_id: "pr_1" }, error: null });
    mockFrom.mockReturnValue(chain);

    await createTask({
      payment_request_id: "pr_1",
      from_agent_wallet: "0xAAAA111122223333444455556666777788889999",
      to_human_wallet: "0xBBBB111122223333444455556666777788889999",
      task_description: "test",
      amount_usdc: 10,
      deadline_unix: 0,
      tx_hash: "0xtx",
      escrow_contract: "0xescrow",
      status: "accepted",
      offer_expiry_unix: 1234567890,
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "accepted",
        offer_expiry_unix: 1234567890,
      }),
    );
  });

  it("createTask defaults to a pending offer with no expiry", async () => {
    const chain = chainable({ data: { id: "1" }, error: null });
    mockFrom.mockReturnValue(chain);

    await createTask({
      payment_request_id: "pr_2",
      from_agent_wallet: "0xAAAA111122223333444455556666777788889999",
      to_human_wallet: "0xBBBB111122223333444455556666777788889999",
      task_description: "test",
      amount_usdc: 10,
      deadline_unix: 0,
      tx_hash: "0xtx",
      escrow_contract: "0xescrow",
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", offer_expiry_unix: null }),
    );
  });

  it("lapseExpiredOffers targets exactly the live, expired offers (CC-094 inline sweep)", async () => {
    const chain = chainable({ data: [{ payment_request_id: "a" }, { payment_request_id: "b" }], error: null });
    mockFrom.mockReturnValue(chain);

    const lapsed = await lapseExpiredOffers();

    expect(lapsed).toBe(2);
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "lapsed" }),
    );
    expect(chain.in).toHaveBeenCalledWith("status", ["pending", "accepted"]);
    expect(chain.not).toHaveBeenCalledWith("offer_expiry_unix", "is", null);
    expect(chain.lte).toHaveBeenCalledWith("offer_expiry_unix", expect.any(Number));
  });

  it("lapseExpiredOffers swallows its failures — a lapse fault must not fail the read", async () => {
    // A chain whose .not call explodes, as the pre-extension mock would have.
    const chain = chainable({ data: null, error: null });
    chain.not = vi.fn(() => {
      throw new TypeError("chain.not is not a function");
    });
    mockFrom.mockReturnValue(chain);

    await expect(lapseExpiredOffers()).resolves.toBe(0);
  });

  it("countCommittedTasks counts accepted+active rows for the D5 cap", async () => {
    const chain = chainable({ data: null, error: null, count: 3 });
    mockFrom.mockReturnValue(chain);

    const committed = await countCommittedTasks("0xCCCC111122223333444455556666777788889999");

    expect(committed).toBe(3);
    expect(chain.eq).toHaveBeenCalledWith(
      "to_human_wallet",
      "0xcccc111122223333444455556666777788889999",
    );
    expect(chain.in).toHaveBeenCalledWith("status", ["accepted", "active"]);
  });

  it("exposes the ADR-0005 D5 concurrency cap", () => {
    expect(WORKER_CONCURRENCY_CAP).toBe(3);
  });

  it("getReputationSummary computes counts correctly", async () => {
    const now = new Date().toISOString();
    const tasks = [
      { status: "completed", amount_usdc: 100, created_at: now },
      { status: "completed", amount_usdc: 50, created_at: now },
      { status: "disputed", amount_usdc: 75, created_at: now },
      { status: "active", amount_usdc: 200, created_at: now },
    ];
    const chain = chainable({ data: tasks, error: null });
    // getTasksByWallet is called internally, which uses order
    mockFrom.mockReturnValue(chain);

    const summary = await getReputationSummary("0x123");
    expect(summary.total_tasks).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.disputed).toBe(1);
    expect(summary.active).toBe(1);
    expect(summary.total_earned_usdc).toBe(150);
  });

  it("getReputationSummary handles empty task list", async () => {
    const chain = chainable({ data: [], error: null });
    mockFrom.mockReturnValue(chain);

    const summary = await getReputationSummary("0x456");
    expect(summary.total_tasks).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.total_earned_usdc).toBe(0);
  });

  it("createTask normalizes both wallet fields to lowercase (CC-002)", async () => {
    const created = { id: "1", payment_request_id: "pr_1" };
    const chain = chainable({ data: created, error: null });
    mockFrom.mockReturnValue(chain);

    await createTask({
      payment_request_id: "pr_1",
      from_agent_wallet: "0xAAAA111122223333444455556666777788889999",
      to_human_wallet: "0xBBBB111122223333444455556666777788889999",
      task_description: "test",
      amount_usdc: 10,
      deadline_unix: 0,
      tx_hash: "0xtx",
      escrow_contract: "0xescrow",
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        from_agent_wallet: "0xaaaa111122223333444455556666777788889999",
        to_human_wallet: "0xbbbb111122223333444455556666777788889999",
      }),
    );
  });

  it("getTasksByWallet queries with a lowercased wallet (CC-002)", async () => {
    const chain = chainable({ data: [], error: null });
    mockFrom.mockReturnValue(chain);

    await getTasksByWallet("0xCCCC111122223333444455556666777788889999");

    expect(chain.eq).toHaveBeenCalledWith(
      "to_human_wallet",
      "0xcccc111122223333444455556666777788889999",
    );
  });

  it("getTasksForParties queries both party columns and dedupes self-hired tasks (CC-093)", async () => {
    const shared = { id: "1", created_at: "2026-08-01T00:00:00Z" };
    const workerOnly = { id: "2", created_at: "2026-08-02T00:00:00Z" };
    const agentOnly = { id: "3", created_at: "2026-07-31T00:00:00Z" };
    // First call is the worker side, second the agent side (CC-093)
    let call = 0;
    mockFrom.mockImplementation(() => {
      const data = call++ === 0 ? [shared, workerOnly] : [shared, agentOnly];
      return chainable({ data, error: null });
    });

    const result = await getTasksForParties("0xCCCC111122223333444455556666777788889999");

    expect(result.map((t) => t.id).sort()).toEqual(["1", "2", "3"]);
    // Latest first
    expect(result[0].id).toBe("2");
  });

  it("getTasksForParties queries with a lowercased wallet on both sides (CC-002)", async () => {
    const workerChain = chainable({ data: [], error: null });
    const agentChain = chainable({ data: [], error: null });
    mockFrom.mockReturnValueOnce(workerChain).mockReturnValueOnce(agentChain);

    await getTasksForParties("0xCCCC111122223333444455556666777788889999");

    expect(workerChain.eq).toHaveBeenCalledWith(
      "to_human_wallet",
      "0xcccc111122223333444455556666777788889999",
    );
    expect(agentChain.eq).toHaveBeenCalledWith(
      "from_agent_wallet",
      "0xcccc111122223333444455556666777788889999",
    );
  });

  it("getPublicTasks reads the tasks_public view through the anon client (CC-093)", async () => {
    const publicRow = { id: "1", payment_request_id: "pr_1" };
    const chain = chainable({ data: [publicRow], error: null });
    mockFromAnon.mockReturnValue(chain);

    const result = await getPublicTasks();

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockFromAnon).toHaveBeenCalledWith("tasks_public");
    expect(chain.limit).toHaveBeenCalled();
    expect(result).toEqual([publicRow]);
  });

  it("getPublicTasks throws on real errors", async () => {
    mockFromAnon.mockReturnValue(
      chainable({ data: null, error: { message: "connection failed" } }),
    );

    await expect(getPublicTasks()).rejects.toThrow("getPublicTasks failed");
  });
});
