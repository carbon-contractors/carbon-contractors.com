import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpServer } from "@/lib/mcp/server";

// CC-099: sanctions screening gates request_human_work on BOTH wallets. The real
// module is hermetic without a key (dataset-only, no network), but mocking it here
// keeps these tests about the *enforcement wiring* — ordering, error shape, and what
// must not run once a screen comes back positive.

const mockIsWalletSanctioned = vi.fn();
vi.mock("@/lib/sanctions", () => ({
  isWalletSanctioned: (...args: unknown[]) => mockIsWalletSanctioned(...args),
}));

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

vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: vi.fn(),
  findTaskByIdempotencyKey: vi.fn().mockResolvedValue(null),
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

const VALID_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
  review_window_hours: 48,
  acceptance_spec: '{"schema_version":1,"criteria":{"min_artefacts":8}}',
};

async function callRequestHumanWork(
  args: Record<string, unknown> = VALID_ARGS,
  callerWallet: string | null = AGENT_WALLET,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools["request_human_work"];
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("request_human_work sanctions screening (CC-099)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: both wallets clean.
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });
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
  });

  it("screens the authenticated caller", async () => {
    await callRequestHumanWork();

    expect(mockIsWalletSanctioned).toHaveBeenCalledWith(AGENT_WALLET);
  });

  it("screens the resolved worker wallet", async () => {
    await callRequestHumanWork();

    expect(mockIsWalletSanctioned).toHaveBeenCalledWith(WORKER_WALLET.toLowerCase());
  });

  it("rejects a sanctioned caller before the rate limiter or any task state", async () => {
    mockIsWalletSanctioned.mockImplementation(async (wallet: string) =>
      wallet === AGENT_WALLET
        ? { sanctioned: true, list: "OFAC SDN", reason: "test designation" }
        : { sanctioned: false },
    );

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBe(true);
    expect(json.code).toBe("SANCTIONED_WALLET");
    expect(json.retryable).toBe(false);
    expect(json.error).toContain("restricted under sanctions compliance");
    expect(mockLimit).not.toHaveBeenCalled();
    expect(mockGetHumanByWallet).not.toHaveBeenCalled();
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
  });

  it("rejects a sanctioned target worker before any task row is created", async () => {
    mockIsWalletSanctioned.mockImplementation(async (wallet: string) =>
      wallet === WORKER_WALLET.toLowerCase()
        ? { sanctioned: true, list: "OFAC SDN", reason: "test designation" }
        : { sanctioned: false },
    );

    const { result, json } = await callRequestHumanWork();

    expect(result.isError).toBe(true);
    expect(json.code).toBe("SANCTIONED_WALLET");
    expect(json.retryable).toBe(false);
    expect(mockInitiateX402Payment).not.toHaveBeenCalled();
    expect(mockNotifyContractor).not.toHaveBeenCalled();
  });

  it("does not leak an idempotent replay to a caller listed since the original call", async () => {
    mockIsWalletSanctioned.mockImplementation(async (wallet: string) =>
      wallet === AGENT_WALLET
        ? { sanctioned: true, list: "OFAC SDN" }
        : { sanctioned: false },
    );
    const { findTaskByIdempotencyKey } = await import("@/lib/db/tasks");
    (findTaskByIdempotencyKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      payment_request_id: "pr_existing",
    });

    const { result, json } = await callRequestHumanWork({
      ...VALID_ARGS,
      idempotency_key: "retry-1",
    });

    // The screen runs BEFORE the idempotency lookup, so a listed agent gets the
    // rejection, not the details of the task it created while clean.
    expect(result.isError).toBe(true);
    expect(json.code).toBe("SANCTIONED_WALLET");
    expect(findTaskByIdempotencyKey).not.toHaveBeenCalled();
  });

  it("logs the rejection event once per blocked call, with the matching role", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Hex-shaped, unlike AGENT_WALLET, because the point is that maskWallet catches it.
    const HEX_CALLER = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    mockIsWalletSanctioned.mockImplementation(async (wallet: string) =>
      wallet === HEX_CALLER ? { sanctioned: true, list: "OFAC SDN" } : { sanctioned: false },
    );

    await callRequestHumanWork(VALID_ARGS, HEX_CALLER);

    const events = consoleSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("request_human_work_sanctioned_wallet_rejected"));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"role":"agent"');
    // The wallet is masked, not raw (CC-009).
    expect(events[0]).not.toContain(HEX_CALLER);
    expect(events[0]).toContain("0xaaaa...1111");

    consoleSpy.mockRestore();
  });

  it("a screening failure fails open — an unlisted caller is not blocked by an outage", async () => {
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });

    const { result } = await callRequestHumanWork();

    expect(result.isError).toBeUndefined();
    expect(mockInitiateX402Payment).toHaveBeenCalledTimes(1);
  });
});
