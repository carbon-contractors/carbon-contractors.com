import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTaskByPaymentId = vi.fn();
const mockUpdateTaskStatus = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
}));

const mockGetOnChainTask = vi.fn();
const mockGetTaskResolvedOutcome = vi.fn();
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
  getTaskResolvedOutcome: (...args: unknown[]) => mockGetTaskResolvedOutcome(...args),
  getEscrowConfig: () => ({ address: "0xEscrow00000000000000000000000000000000", chainId: 84532, chainName: "Base Sepolia" }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

const mockResolveDisputeOnChain = vi.fn();
vi.mock("@/lib/contracts/signer", () => ({
  resolveDisputeOnChain: (...args: unknown[]) => mockResolveDisputeOnChain(...args),
}));

const AGENT_WALLET = "0xagentagentagentagentagentagentagentagen";

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    payment_request_id: "pr_1",
    from_agent_wallet: AGENT_WALLET,
    to_human_wallet: "0xworkerworkerworkerworkerworkerworkerwork",
    amount_usdc: 10,
    status: "disputed",
    ...overrides,
  };
}

// The MCP SDK stores each registered tool's raw callback on `_registeredTools[name].handler`.
// Calling it directly exercises the real business logic without standing up a transport.
async function callResolveDispute(
  args: { payment_request_id: string; release_to_worker: boolean; resolution_note: string },
) {
  const { createMcpServer } = await import("@/lib/mcp/server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet: AGENT_WALLET }) as any;
  const tool = server._registeredTools["resolve_dispute"];
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("resolve_dispute MCP tool (CC-065)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls resolveDisputeOnChain, then updates DB to completed, when releasing to the worker", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Disputed" });
    mockResolveDisputeOnChain.mockResolvedValue("0xresolvetxhash");
    mockUpdateTaskStatus.mockResolvedValue(undefined);

    const { result, json } = await callResolveDispute({
      payment_request_id: "pr_1",
      release_to_worker: true,
      resolution_note: "worker delivered, releasing funds",
    });

    expect(result.isError).toBeUndefined();
    expect(mockResolveDisputeOnChain).toHaveBeenCalledWith("0xtaskid-pr_1", true);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "completed");
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.tx_hash).toBe("0xresolvetxhash");
  });

  it("calls resolveDisputeOnChain, then updates DB to expired, when refunding the agent", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Disputed" });
    mockResolveDisputeOnChain.mockResolvedValue("0xrefundtxhash");
    mockUpdateTaskStatus.mockResolvedValue(undefined);

    const { json } = await callResolveDispute({
      payment_request_id: "pr_1",
      release_to_worker: false,
      resolution_note: "worker never delivered, refunding agent",
    });

    expect(mockResolveDisputeOnChain).toHaveBeenCalledWith("0xtaskid-pr_1", false);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "expired");
    expect(json.status).toBe("expired");
  });

  it("does NOT update the DB if the on-chain call reverts — no DB/chain divergence", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Disputed" });
    mockResolveDisputeOnChain.mockRejectedValue(new Error("OwnableUnauthorizedAccount"));

    const { result, json } = await callResolveDispute({
      payment_request_id: "pr_1",
      release_to_worker: true,
      resolution_note: "attempting release",
    });

    expect(result.isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("OwnableUnauthorizedAccount");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("recovers the true outcome instead of trusting the input, when a prior attempt already resolved on-chain", async () => {
    // Simulates: an earlier call succeeded on-chain (released to worker) but the DB write
    // afterward failed, and this is a retry — possibly with a different argument.
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Resolved" });
    mockGetTaskResolvedOutcome.mockResolvedValue({ releasedToWorker: true, amount: BigInt(10_000_000) });
    mockUpdateTaskStatus.mockResolvedValue(undefined);

    const { json } = await callResolveDispute({
      payment_request_id: "pr_1",
      release_to_worker: false, // mismatched retry argument — must not be trusted
      resolution_note: "retrying after a prior failure",
    });

    expect(mockResolveDisputeOnChain).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "completed");
    expect(json.release_to_worker).toBe(true);
    expect(json.tx_hash).toBeNull();
  });

  it("surfaces a DB/chain mismatch instead of guessing, when chain state is neither Disputed nor Resolved", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Funded" });

    const { result, json } = await callResolveDispute({
      payment_request_id: "pr_1",
      release_to_worker: true,
      resolution_note: "attempting release",
    });

    expect(result.isError).toBe(true);
    expect(json.error).toContain("DB/chain state mismatch");
    expect(mockResolveDisputeOnChain).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("rejects a task that is not currently disputed in the DB", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask({ status: "active" }));

    const { result, json } = await callResolveDispute({
      payment_request_id: "pr_1",
      release_to_worker: true,
      resolution_note: "attempting release",
    });

    expect(result.isError).toBe(true);
    expect(json.error).toContain("can only resolve disputed tasks");
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });
});
