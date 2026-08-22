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

vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: vi.fn(),
  updateTaskStatus: vi.fn(),
  countCommittedTasks: vi.fn().mockResolvedValue(0),
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

/**
 * CC-046 pre-set parameters. Chain id, escrow address, USDC address and RPC URL
 * are server-config constants — no MCP tool may accept any of them as an
 * argument. This kills the lookalike-token vector (an agent passing a malicious
 * USDC or escrow address) and the wrong-chain vector in one move. The schema is
 * the contract real callers meet, so asserting on it is the enforcement.
 */
const FORBIDDEN_PARAMS = [
  "chain_id",
  "chainId",
  "chain",
  "network",
  "network_name",
  "rpc_url",
  "rpc",
  "rpc_endpoint",
  "provider_url",
  "web3_url",
  "escrow_address",
  "escrow_contract",
  "escrow",
  "contract_address",
  "usdc_address",
  "usdc",
  "token_address",
  "payment_token",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registeredTools(): [string, any][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer() as any;
  return Object.entries(server._registeredTools);
}

describe("MCP pre-set chain parameters (CC-046)", () => {
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
  });

  it("no tool accepts chain/escrow/USDC/RPC arguments — they are config constants", () => {
    const tools = registeredTools();

    // Guard against a vacuous pass: the full 10-tool surface must be registered.
    expect(tools.length).toBeGreaterThanOrEqual(10);

    for (const [name, tool] of tools) {
      const params: string[] = Object.keys(tool.inputSchema?.shape ?? {});
      for (const param of params) {
        expect(
          FORBIDDEN_PARAMS,
          `${name} must not accept caller-supplied '${param}'`,
        ).not.toContain(param);
      }
    }
  });

  it("smuggled chain parameters are dropped, never reaching the task creation call", async () => {
    // Even past the schema (direct handler invocation), a caller-supplied
    // escrow/USDC/chain/rpc value must never reach initiateX402Payment —
    // the handler destructures only the known arguments.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer({ callerWallet: AGENT_WALLET }) as any;
    const tool = server._registeredTools["request_human_work"];
    await tool.handler({
      ...VALID_ARGS,
      chain_id: 1,
      escrow_contract: "0xEvil00000000000000000000000000000000000",
      usdc_address: "0xEvil000000000000000000000000000000000001",
      rpc_url: "https://evil.example/rpc",
    });

    expect(mockInitiateX402Payment).toHaveBeenCalledTimes(1);
    const call = mockInitiateX402Payment.mock.calls[0][0];
    expect(call).not.toHaveProperty("chain_id");
    expect(call).not.toHaveProperty("escrow_contract");
    expect(call).not.toHaveProperty("usdc_address");
    expect(call).not.toHaveProperty("rpc_url");
    // What it does receive is the worker's registered wallet — not any caller cased value.
    expect(call.to_human_wallet).toBe(WORKER_WALLET.toLowerCase());
  });
});
