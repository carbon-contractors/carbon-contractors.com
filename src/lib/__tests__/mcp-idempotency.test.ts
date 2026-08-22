import { describe, it, expect, vi, beforeEach } from "vitest";
// Static, not dynamic: `vi.mock` is hoisted above it (see mcp-request-human-work.test.ts).
import { createMcpServer } from "@/lib/mcp/server";

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
  searchByCategory: vi.fn(),
  getAllHumans: vi.fn(),
  getHumanById: vi.fn(),
  getDistinctCategories: vi.fn(),
}));

const mockInitiateX402Payment = vi.fn();
const mockReplayX402Payment = vi.fn();
vi.mock("@/lib/payments/x402", () => ({
  initiateX402Payment: (...args: unknown[]) => mockInitiateX402Payment(...args),
  replayX402Payment: (...args: unknown[]) => mockReplayX402Payment(...args),
}));

const mockLimit = vi.fn();
vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: { limit: (...args: unknown[]) => mockLimit(...args) },
}));

const mockFindTaskByIdempotencyKey = vi.fn();
const mockCountCommittedTasks = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: (...args: unknown[]) => mockCountCommittedTasks(...args),
  findTaskByIdempotencyKey: (...args: unknown[]) =>
    mockFindTaskByIdempotencyKey(...args),
  WORKER_CONCURRENCY_CAP: 3,
}));

const mockGetChannelsForContractor = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  registerNotificationChannel: vi.fn(),
  getChannelsForContractor: (...args: unknown[]) => mockGetChannelsForContractor(...args),
}));

const mockNotifyContractor = vi.fn();
vi.mock("@/lib/notifications/dispatch", () => ({
  notifyContractor: (...args: unknown[]) => mockNotifyContractor(...args),
}));

vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: vi.fn(),
  getTaskResolvedOutcome: vi.fn(),
  getEscrowConfig: () => ({
    address: "0xEscrow00000000000000000000000000000000",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

vi.mock("@/lib/contracts/signer", () => ({
  resolveDisputeOnChain: vi.fn(),
}));

vi.mock("@/lib/awol", () => ({
  evaluateAwolAtBooking: vi.fn().mockResolvedValue({
    evaluated: false,
    triggered: false,
    signal: null,
    consecutiveLapsedOffers: 0,
    consecutiveExpiredTasks: 0,
  }),
}));

const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent";
const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";
const KEY = "hire-attempt-42";

const VALID_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
  review_window_hours: 48,
  acceptance_spec: '{"schema_version":1,"criteria":{"min_artefacts":8}}',
  idempotency_key: KEY,
};

// A stored task row as findTaskByIdempotencyKey would return it.
const EXISTING_ROW = {
  id: "row-uuid",
  payment_request_id: "pr_existing",
  from_agent_wallet: AGENT_WALLET.toLowerCase(),
  to_human_wallet: WORKER_WALLET.toLowerCase(),
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_unix: 9999999999,
  status: "pending",
  offer_expiry_unix: 9999999999,
  tx_hash: "",
  escrow_contract: "0xEscrow00000000000000000000000000000000",
  acceptance_spec: VALID_ARGS.acceptance_spec,
  spec_hash: "0x" + "a".repeat(64),
  spec_schema_version: 1,
  funded_at: null,
  content_purged_at: null,
  content_purge_rule: null,
  idempotency_key: KEY,
  review_window_seconds: 48 * 3600,
  created_at: new Date().toISOString(),
};

async function callRequestHumanWork(
  args: Record<string, unknown> = VALID_ARGS,
  callerWallet: string | null = AGENT_WALLET,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools["request_human_work"];
  const result = await tool.handler(args);
  return { result, tool, json: JSON.parse(result.content[0].text) };
}

describe("request_human_work idempotency (CC-046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue({ success: true, remaining: 29, retryAfterS: 0 });
    mockGetHumanByWallet.mockResolvedValue({
      id: "human-uuid",
      wallet: WORKER_WALLET.toLowerCase(),
      categories: ["delivery-errands"],
      rate_usdc: 40,
      availability: "available",
      reputation_score: 80,
    });
    mockInitiateX402Payment.mockResolvedValue({
      status: "awaiting_funding",
      payment_request_id: "pr_new",
      worker_status: "pending",
      offer_expiry_unix: 9999999999,
    });
    mockReplayX402Payment.mockImplementation((row: { payment_request_id: string }) => ({
      status: "awaiting_funding",
      payment_request_id: row.payment_request_id,
      worker_status: "pending",
    }));
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockNotifyContractor.mockResolvedValue({ notified_channels: 0 });
    mockCountCommittedTasks.mockResolvedValue(0);
    mockFindTaskByIdempotencyKey.mockResolvedValue(null);
  });

  it("returns the existing task unchanged when the key already resolved to one", async () => {
    mockFindTaskByIdempotencyKey.mockResolvedValue(EXISTING_ROW);

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.idempotent_replay).toBe(true);
    expect(json.payment_request_id).toBe("pr_existing");
    // No second task, ever — the whole point of the key.
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the authenticated caller's wallet", async () => {
    mockFindTaskByIdempotencyKey.mockResolvedValue(null);
    await callRequestHumanWork();

    expect(mockFindTaskByIdempotencyKey).toHaveBeenCalledWith(AGENT_WALLET, KEY);
  });

  it("replays before burning a rate-limit token — a retry is not a new creation", async () => {
    mockFindTaskByIdempotencyKey.mockResolvedValue(EXISTING_ROW);

    await callRequestHumanWork();

    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("does not notify the worker again on replay", async () => {
    mockFindTaskByIdempotencyKey.mockResolvedValue(EXISTING_ROW);

    await callRequestHumanWork();

    expect(mockNotifyContractor).not.toHaveBeenCalled();
  });

  it("creates a new task when the key is fresh", async () => {
    const { json } = await callRequestHumanWork();

    expect(json.ok).toBe(true);
    expect(json.idempotent_replay).toBeUndefined();
    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: KEY }),
    );
  });

  it("recovers a concurrent insert conflict by replaying the winner (23505)", async () => {
    // The TTL lookup missed, but migration 020's unique index means a racing
    // duplicate insert fails — the loser must replay the winner's row, not error.
    mockFindTaskByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(EXISTING_ROW);
    mockInitiateX402Payment.mockRejectedValue(
      new Error('createTask failed (23505): duplicate key value violates unique constraint "tasks_agent_idempotency_key_uidx"'),
    );

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.idempotent_replay).toBe(true);
    expect(json.replayed_after_conflict).toBe(true);
    expect(json.payment_request_id).toBe("pr_existing");
    expect(mockReplayX402Payment).toHaveBeenCalledWith(EXISTING_ROW);
  });

  it("surfaces an error when the conflict has no retrievable row", async () => {
    mockFindTaskByIdempotencyKey.mockResolvedValue(null);
    mockInitiateX402Payment.mockRejectedValue(
      new Error('createTask failed (23505): duplicate key value violates unique constraint "tasks_agent_idempotency_key_uidx"'),
    );

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("INTERNAL");
  });

  it("declares idempotency_key optional and bounded in the tool schema", async () => {
    const { tool } = await callRequestHumanWork();
    const shape = tool.inputSchema.shape;

    expect(shape.idempotency_key.isOptional()).toBe(true);
    expect(() =>
      tool.inputSchema.parse({ ...VALID_ARGS, idempotency_key: "x".repeat(129) }),
    ).toThrow();
  });

  it("works without an idempotency_key — it is optional, not required", async () => {
    const { idempotency_key: _omitted, ...withoutKey } = VALID_ARGS as Record<string, unknown>;
    void _omitted;
    const { json } = await callRequestHumanWork(withoutKey);

    expect(json.ok).toBe(true);
    expect(mockFindTaskByIdempotencyKey).not.toHaveBeenCalled();
    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.not.objectContaining({ idempotency_key: expect.anything() }),
    );
  });
});
