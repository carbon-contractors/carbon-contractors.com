import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTaskByPaymentId = vi.fn();
const mockUpdateTaskStatus = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
}));

const mockGetOnChainTask = vi.fn();
vi.mock("@/lib/contracts/escrow", () => ({
  getOnChainTask: (...args: unknown[]) => mockGetOnChainTask(...args),
  getTaskResolvedOutcome: vi.fn(),
  getEscrowConfig: () => ({ address: "0xEscrow00000000000000000000000000000000", chainId: 84532, chainName: "Base Sepolia" }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

// CC-080: the platform signer is no longer in this tool's path at all. Mocked so a
// regression that reintroduces it fails on "module has no export" style wiring, not
// by silently reaching for a real signer.
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
    status: "active",
    ...overrides,
  };
}

// The MCP SDK stores each registered tool's raw callback on `_registeredTools[name].handler`.
// Calling it directly exercises the real business logic without standing up a transport.
async function callConfirmCompletion(
  args: { payment_request_id: string },
  callerWallet: string | null = AGENT_WALLET,
) {
  const { createMcpServer } = await import("@/lib/mcp/server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools["confirm_task_completion"];
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("confirm_task_completion MCP tool (CC-080)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOnChainTask.mockResolvedValue({ state: "Funded" });
  });

  it("requires an authenticated caller", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());

    const { result, json } = await callConfirmCompletion(
      { payment_request_id: "pr_1" },
      null,
    );

    expect(result.isError).toBe(true);
    expect(json.error).toContain("Authentication required");
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not the originating agent", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());

    const { result, json } = await callConfirmCompletion(
      { payment_request_id: "pr_1" },
      "0ximposterimposterimposterimposterimposte",
    );

    expect(result.isError).toBe(true);
    expect(json.error).toContain("Not authorized");
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });

  it("rejects an unknown payment_request_id", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(null);

    const { result, json } = await callConfirmCompletion({ payment_request_id: "pr_nope" });

    expect(result.isError).toBe(true);
    expect(json.error).toBe("Task not found");
  });

  it("rejects a task whose DB status is not confirmable", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask({ status: "disputed" }));

    const { result, json } = await callConfirmCompletion({ payment_request_id: "pr_1" });

    expect(result.isError).toBe(true);
    expect(json.error).toContain("cannot confirm completion");
  });

  it("returns an idempotent ok for an already-completed task", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask({ status: "completed" }));

    const { result, json } = await callConfirmCompletion({ payment_request_id: "pr_1" });

    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(mockGetOnChainTask).not.toHaveBeenCalled();
  });

  it("makes no on-chain write and no DB status change — settlement is the agent's", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());

    const { result, json } = await callConfirmCompletion({ payment_request_id: "pr_1" });

    expect(result.isError).toBeUndefined();
    // The two CC-080 assertions: the platform neither transacts nor flips the DB.
    expect(mockResolveDisputeOnChain).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    // The DB status is reported honestly — no payout has occurred.
    expect(json.status).toBe("active");
    expect(json.ok).toBe(true);
  });

  it("returns the taskId, escrow address and settlement guidance", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Delivered" });

    const { json } = await callConfirmCompletion({ payment_request_id: "pr_1" });

    expect(json.task_id_bytes32).toBe("0xtaskid-pr_1");
    expect(json.escrow_contract).toBe("0xEscrow00000000000000000000000000000000");
    expect(json.on_chain_state).toBe("Delivered");
    expect(json.settlement.performed_by).toBe("agent");
    expect(json.settlement.early_path).toContain("completeTask");
    expect(json.settlement.default_path).toContain("releaseAfterReview");
    expect(json.settlement.note).toContain("review window");
  });

  it("says settlement already happened when the chain shows Completed", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Completed" });

    const { json } = await callConfirmCompletion({ payment_request_id: "pr_1" });

    expect(json.on_chain_state).toBe("Completed");
    expect(json.settlement.note).toContain("already occurred");
  });

  it("omits on-chain state rather than failing when the contract is unreachable", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockRejectedValue(new Error("eth_call reverted"));

    const { result, json } = await callConfirmCompletion({ payment_request_id: "pr_1" });

    expect(result.isError).toBeUndefined();
    expect(json.on_chain_state).toBeNull();
    expect(json.settlement.note).toContain("agent's action");
  });
});
