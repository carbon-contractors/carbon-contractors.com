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
  completeTaskOnChain: vi.fn(),
  resolveDisputeOnChain: vi.fn(),
}));

const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent";
const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK";

const VALID_ARGS = {
  to_human_wallet: WORKER_WALLET,
  task_description: "Photograph the switchboard in Rack Room 2",
  amount_usdc: 25,
  deadline_hours: 24,
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
    });
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
    });
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

  it("passes spec: null when the agent supplies none", async () => {
    await callRequestHumanWork();

    expect(mockInitiateX402Payment).toHaveBeenCalledWith(
      expect.objectContaining({ spec: null }),
    );
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
