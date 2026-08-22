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
vi.mock("@/lib/payments/x402", () => ({
  initiateX402Payment: (...args: unknown[]) => mockInitiateX402Payment(...args),
  replayX402Payment: vi.fn(),
}));

const mockLimit = vi.fn();
vi.mock("@/lib/ratelimit", () => ({
  taskCreationRateLimiter: { limit: (...args: unknown[]) => mockLimit(...args) },
}));

const mockGetTaskByPaymentId = vi.fn();
const mockFindTaskByIdempotencyKey = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: vi.fn().mockResolvedValue(0),
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

// Intake pause is the retryable-with-notice path (ADR-0003 D4) — driven from here
// rather than env so each test can pick a posture.
const mockIsIntakePaused = vi.fn();
vi.mock("@/lib/config", () => ({
  isIntakePaused: (...args: unknown[]) => mockIsIntakePaused(...args),
}));

const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent";
const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";

const VALID_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
  review_window_hours: 48,
  acceptance_spec: '{"schema_version":1,"criteria":{"min_artefacts":8}}',
};

// The CC-046 contract every tool error must satisfy: { error, code, retryable }
// (+ optional reason), so an autonomous agent can branch without parsing prose.
function assertErrorContract(json: Record<string, unknown>) {
  expect(json.ok).toBe(false);
  expect(typeof json.error).toBe("string");
  expect((json.error as string).length).toBeGreaterThan(0);
  expect(typeof json.code).toBe("string");
  expect(typeof json.retryable).toBe("boolean");
}

async function callTool(name: string, args: Record<string, unknown>, callerWallet: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools[name];
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("MCP structured error semantics (CC-046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIntakePaused.mockReturnValue({ paused: false, notice: null });
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
    mockFindTaskByIdempotencyKey.mockResolvedValue(null);
  });

  it("unauthenticated → UNAUTHENTICATED, not retryable", async () => {
    const { json } = await callTool("request_human_work", VALID_ARGS, null);

    assertErrorContract(json);
    expect(json.code).toBe("UNAUTHENTICATED");
    expect(json.retryable).toBe(false);
  });

  it("rate limited → RATE_LIMITED, retryable, with retry_after_s", async () => {
    mockLimit.mockResolvedValue({ success: false, remaining: 0, retryAfterS: 1800 });

    const { json } = await callTool("request_human_work", VALID_ARGS, AGENT_WALLET);

    assertErrorContract(json);
    expect(json.code).toBe("RATE_LIMITED");
    expect(json.retryable).toBe(true);
    expect(json.retry_after_s).toBe(1800);
  });

  it("intake paused → INTAKE_PAUSED, retryable, with claims_active", async () => {
    mockIsIntakePaused.mockReturnValue({
      paused: true,
      notice: "post-incident freeze (test)",
    });

    const { json } = await callTool("request_human_work", VALID_ARGS, AGENT_WALLET);

    assertErrorContract(json);
    expect(json.code).toBe("INTAKE_PAUSED");
    expect(json.retryable).toBe(true);
    expect(json.retry_after_s).toBe(300);
    expect(json.claims_active).toBe(true);
  });

  it("unregistered worker → UNREGISTERED_WORKER, not retryable", async () => {
    mockGetHumanByWallet.mockResolvedValue(null);

    const { json } = await callTool("request_human_work", VALID_ARGS, AGENT_WALLET);

    assertErrorContract(json);
    expect(json.code).toBe("UNREGISTERED_WORKER");
    expect(json.retryable).toBe(false);
  });

  it("malformed spec → INVALID_SPEC, not retryable (deterministic)", async () => {
    const { json } = await callTool(
      "request_human_work",
      { ...VALID_ARGS, acceptance_spec: '{"schema_version":1,"criteria":{"vibes_check":true}}' },
      AGENT_WALLET,
    );

    assertErrorContract(json);
    expect(json.code).toBe("INVALID_SPEC");
    expect(json.retryable).toBe(false);
  });

  it("unknown task → TASK_NOT_FOUND, not retryable", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(null);

    const { json } = await callTool(
      "get_task_status",
      { payment_request_id: "nope" },
      AGENT_WALLET,
    );

    assertErrorContract(json);
    expect(json.code).toBe("TASK_NOT_FOUND");
    expect(json.retryable).toBe(false);
  });

  it("non-owner confirming → FORBIDDEN, not retryable", async () => {
    mockGetTaskByPaymentId.mockResolvedValue({
      from_agent_wallet: "0xsomeoneelse00000000000000000000000000000",
      to_human_wallet: WORKER_WALLET.toLowerCase(),
      status: "active",
      amount_usdc: 25,
    });

    const { json } = await callTool(
      "confirm_task_completion",
      { payment_request_id: "pr_1" },
      AGENT_WALLET,
    );

    assertErrorContract(json);
    expect(json.code).toBe("FORBIDDEN");
    expect(json.retryable).toBe(false);
  });

  it("terminal task state → INVALID_TASK_STATE, not retryable", async () => {
    mockGetTaskByPaymentId.mockResolvedValue({
      from_agent_wallet: AGENT_WALLET.toLowerCase(),
      to_human_wallet: WORKER_WALLET.toLowerCase(),
      status: "expired",
      amount_usdc: 25,
    });

    const { json } = await callTool(
      "confirm_task_completion",
      { payment_request_id: "pr_1" },
      AGENT_WALLET,
    );

    assertErrorContract(json);
    expect(json.code).toBe("INVALID_TASK_STATE");
    expect(json.retryable).toBe(false);
  });

  it("unexpected fault → INTERNAL, retryable", async () => {
    mockGetHumanByWallet.mockRejectedValue(new Error("supabase connection reset"));

    const { json } = await callTool("request_human_work", VALID_ARGS, AGENT_WALLET);

    assertErrorContract(json);
    expect(json.code).toBe("INTERNAL");
    expect(json.retryable).toBe(true);
  });
});
