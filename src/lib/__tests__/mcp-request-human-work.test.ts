import { describe, it, expect, vi, beforeEach } from "vitest";
// Static, not dynamic: `vi.mock` is hoisted above it, and loading the MCP SDK graph
// lazily inside the first test charged ~8s of cold module resolution to that test's
// timeout on Windows.
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
const mockCountCommittedTasks = vi.fn();
vi.mock("@/lib/payments/x402", () => ({
  initiateX402Payment: (...args: unknown[]) => mockInitiateX402Payment(...args),
}));

const mockLimit = vi.fn();
vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: { limit: (...args: unknown[]) => mockLimit(...args) },
}));

vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: (...args: unknown[]) => mockCountCommittedTasks(...args),
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

// CC-075: the inline AWOL check runs on every hire. Default to "not
// triggered" — its own behaviour is covered in awol.test.ts.
const mockEvaluateAwolAtBooking = vi.fn().mockResolvedValue({
  evaluated: false,
  triggered: false,
  signal: null,
  consecutiveLapsedOffers: 0,
  consecutiveExpiredTasks: 0,
});
vi.mock("@/lib/awol", () => ({
  evaluateAwolAtBooking: (...args: unknown[]) => mockEvaluateAwolAtBooking(...args),
}));

const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent";
const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";

const VALID_SPEC = '{"schema_version":1,"criteria":{"min_artefacts":8}}';

const VALID_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
  review_window_hours: 48,
  acceptance_spec: VALID_SPEC,
};

// The MCP SDK stores each registered tool's raw callback on
// `_registeredTools[name].handler`. Calling it directly exercises the real
// business logic without standing up a transport.
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

describe("request_human_work MCP tool (CC-081 Defect 4)", () => {
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
      payment_request_id: "pr_1",
      worker_status: "pending",
      offer_expiry_unix: 9999999999,
    });
    // Default: no channels, so no auto-booking — the offer waits (ADR-0005 D3).
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockNotifyContractor.mockResolvedValue({ notified_channels: 0 });
    mockCountCommittedTasks.mockResolvedValue(0);
  });

  it("rejects an unauthenticated caller instead of creating a task row", async () => {
    const { result, json } = await callRequestHumanWork(VALID_ARGS, null);

    expect(result.isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Authentication required");
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
    expect(mockGetHumanByWallet).not.toHaveBeenCalled();
  });

  it("attributes the task to the authenticated caller", async () => {
    const { result } = await callRequestHumanWork();

    expect(result.isError).toBeUndefined();
    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ from_agent_wallet: AGENT_WALLET }),
    );
  });

  it("derives review_window_seconds from the agent's chosen window (CC-081 Defect 1)", async () => {
    await callRequestHumanWork({ ...VALID_ARGS, review_window_hours: 72 });

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ review_window_seconds: 72 * 3600 }),
    );
  });

  it("does not accept from_agent_wallet as an argument — provenance cannot be asserted", async () => {
    const { tool } = await callRequestHumanWork({
      ...VALID_ARGS,
      from_agent_wallet: "0xIMPERSONATEDimpersonatedIMPERSONATED0000",
    });

    // The schema no longer declares it, so it cannot be supplied...
    const declared = Object.keys(tool.inputSchema.shape);
    expect(declared).toContain("to_human_wallet"); // guards against a vacuous pass
    expect(declared).not.toContain("from_agent_wallet");
    // ...and even when smuggled past the schema it never reaches the task row.
    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ from_agent_wallet: AGENT_WALLET }),
    );
  });

  it("rejects a to_human_wallet that belongs to no registered worker", async () => {
    mockGetHumanByWallet.mockResolvedValue(null);

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBe(true);
    expect(json.error).toContain("registered worker");
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("persists the wallet as stored in humans, not as the caller cased it", async () => {
    // Migration 014 CHECK-constrains humans.wallet to lowercase; a mixed-case
    // payout destination would silently mismatch on every later lookup (CC-002).
    await callRequestHumanWork();

    expect(mockGetHumanByWallet).toHaveBeenCalledWith(WORKER_WALLET);
    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ to_human_wallet: WORKER_WALLET.toLowerCase() }),
    );
  });

  it("rate limits per caller wallet, not per IP", async () => {
    mockLimit.mockResolvedValue({ success: false, remaining: 0, retryAfterS: 1800 });

    const { result, json } = await callRequestHumanWork();

    expect(mockLimit).toHaveBeenCalledWith(AGENT_WALLET.toLowerCase());
    expect(result.isError).toBe(true);
    expect(json.retry_after_s).toBe(1800);
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("checks authentication before spending a rate-limit token", async () => {
    await callRequestHumanWork(VALID_ARGS, null);

    expect(mockLimit).not.toHaveBeenCalled();
  });
});

describe("request_human_work acceptance spec (CC-084)", () => {
  const VALID_SPEC = '{"schema_version":1,"criteria":{"min_artefacts":8}}';

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
      payment_request_id: "pr_1",
      worker_status: "pending",
      offer_expiry_unix: 9999999999,
    });
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockNotifyContractor.mockResolvedValue({ notified_channels: 0 });
    mockCountCommittedTasks.mockResolvedValue(0);
  });

  it("passes the parsed spec and its hash through to the payment request", async () => {
    await callRequestHumanWork({ ...VALID_ARGS, acceptance_spec: VALID_SPEC });

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          preimage: VALID_SPEC, // verbatim — never reserialised
          hash: "0x95488785ad9098de2b47cd8e031a10509c63766075e0b2de83f5a1902e8466a4",
          version: 1,
          hasNoCriteria: false,
        }),
      }),
    );
  });

  it("rejects a missing acceptance_spec before any task row is created (CC-081 Defect 1)", async () => {
    const { acceptance_spec: _omitted, ...argsWithoutSpec } = VALID_ARGS as Record<string, unknown>;
    void _omitted;
    const { result, json } = await callRequestHumanWork(argsWithoutSpec);

    expect(result.isError).toBe(true);
    expect(json.error).toContain("acceptance_spec is required");
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("declares acceptance_spec as required in the tool schema", async () => {
    // The schema is the contract real callers meet; the handler guard above only
    // covers direct invocation. Assert both so one cannot silently loosen.
    const { tool } = await callRequestHumanWork();
    const shape = tool.inputSchema.shape;

    expect(Object.keys(shape)).toContain("acceptance_spec");
    expect(shape.acceptance_spec.isOptional()).toBe(false);
  });

  it("rejects a review window outside the contract's 12h–14d bounds at the schema layer", async () => {
    const { tool } = await callRequestHumanWork();

    expect(() =>
      tool.inputSchema.parse({ ...VALID_ARGS, review_window_hours: 6 }),
    ).toThrow();
    expect(() =>
      tool.inputSchema.parse({ ...VALID_ARGS, review_window_hours: 400 }),
    ).toThrow();
  });

  it("rejects a malformed spec before any task row is created", async () => {
    const { result, json } = await callRequestHumanWork({
      ...VALID_ARGS,
      acceptance_spec: '{"schema_version":1,"criteria":{"vibes_check":true}}',
    });

    expect(result.isError).toBe(true);
    expect(json.error).toContain("acceptance_spec is invalid");
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("rejects an unsupported schema version with a usable message", async () => {
    const { result, json } = await callRequestHumanWork({
      ...VALID_ARGS,
      acceptance_spec: '{"schema_version":99,"criteria":{}}',
    });

    expect(result.isError).toBe(true);
    expect(json.error).toContain("unsupported schema_version 99");
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });
});

describe("request_human_work offer lifecycle (CC-094 / ADR-0005)", () => {
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
      payment_request_id: "pr_1",
      worker_status: "pending",
      offer_expiry_unix: 9999999999,
    });
    mockGetChannelsForContractor.mockResolvedValue([]);
    mockNotifyContractor.mockResolvedValue({ notified_channels: 1 });
    mockCountCommittedTasks.mockResolvedValue(0);
  });

  it("reads the worker's channels — the flag becomes a gate, not metadata (D3)", async () => {
    await callRequestHumanWork();

    expect(mockGetChannelsForContractor).toHaveBeenCalledWith("human-uuid");
  });

  it("keeps the offer pending when no channel has accepts_auto_booking (D3)", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      { id: "ch1", type: "email", address: "redacted", accepts_auto_booking: false },
    ]);

    await callRequestHumanWork();

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ auto_accept: false }),
    );
  });

  it("auto-accepts when any channel has accepts_auto_booking (D3)", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      { id: "ch1", type: "email", address: "redacted", accepts_auto_booking: false },
      { id: "ch2", type: "telegram", address: "redacted", accepts_auto_booking: true },
    ]);

    await callRequestHumanWork();

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ auto_accept: true }),
    );
    // Skip-count check only happens on the auto path.
    expect(mockCountCommittedTasks).toHaveBeenCalledWith(WORKER_WALLET.toLowerCase());
  });

  it("refuses to auto-book a worker already at the concurrency cap (D5)", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      { id: "ch2", type: "telegram", address: "redacted", accepts_auto_booking: true },
    ]);
    mockCountCommittedTasks.mockResolvedValue(3);

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBe(true);
    expect(json.error).toContain("concurrency cap");
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("passes the agent-set offer expiry through, bounded at the schema layer (D4)", async () => {
    await callRequestHumanWork({ ...VALID_ARGS, offer_expiry_minutes: 30 });

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ offer_expiry_seconds: 30 * 60 }),
    );
  });

  it("defaults the offer expiry to 24 hours (ADR-0005 D4 open item, resolved)", async () => {
    await callRequestHumanWork();

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ offer_expiry_seconds: 24 * 60 * 60 }),
    );
  });

  it("rejects an offer expiry outside the 15m–7d bounds at the schema layer (D4)", async () => {
    const { tool } = await callRequestHumanWork();

    expect(() =>
      tool.inputSchema.parse({ ...VALID_ARGS, offer_expiry_minutes: 14 }),
    ).toThrow();
    expect(() =>
      tool.inputSchema.parse({ ...VALID_ARGS, offer_expiry_minutes: 10081 }),
    ).toThrow();
  });

  it("notifies the worker's channels of the offer (ADR-0005 D7, CC-095 seam)", async () => {
    await callRequestHumanWork();

    expect(mockNotifyContractor).toHaveBeenCalledWith(
      "human-uuid",
      expect.objectContaining({ type: "offer_received", payment_request_id: "pr_1" }),
    );
    // Manual-accept path: one event only, no task_funded.
    expect(mockNotifyContractor).toHaveBeenCalledTimes(1);
  });

  it("also records the auto-booked commitment on the auto path", async () => {
    mockGetChannelsForContractor.mockResolvedValue([
      { id: "ch2", type: "telegram", address: "redacted", accepts_auto_booking: true },
    ]);

    await callRequestHumanWork();

    const types = mockNotifyContractor.mock.calls.map(([, ev]) => ev.type);
    expect(types).toContain("offer_received");
    expect(types).toContain("task_funded");
  });
});
