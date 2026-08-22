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
  getEscrowConfig: () => ({
    address: "0xEscrow00000000000000000000000000000000",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (paymentRequestId: string) => `0xtaskid-${paymentRequestId}`,
}));

const mockComputeAndSignVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contracts/verdict-service")>();
  return {
    ...actual,
    computeAndSignVerdict: (...args: unknown[]) => mockComputeAndSignVerdict(...args),
  };
});

const WORKER_WALLET = "0xworkerworkerworkerworkerworkerworkerwork";
const AGENT_WALLET = "0xagentagentagentagentagentagentagentagen";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const EVIDENCE_BUNDLE = JSON.stringify({
  taskId: "pr_1",
  artifacts: [{ uri: "https://example.com/a.jpg" }],
});

const FAILING_VERDICT = {
  taskId: "0x" + "11".repeat(32),
  specHash: "0x" + "aa".repeat(32),
  evidenceHash: "0x" + "bb".repeat(32),
  checkerHash: "0x" + "33".repeat(32),
  passed: false,
  breakdownHash: "0x" + "44".repeat(32),
  expiry: BigInt(1_700_003_600),
  nonce: BigInt(42),
};

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    payment_request_id: "pr_1",
    from_agent_wallet: AGENT_WALLET,
    to_human_wallet: WORKER_WALLET,
    amount_usdc: 10,
    status: "active",
    acceptance_spec: '{"schema_version":1,"criteria":{}}',
    spec_hash: "0x" + "aa".repeat(32),
    spec_schema_version: 1,
    funded_at: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

// The MCP SDK stores each registered tool's raw callback on
// `_registeredTools[name].handler`. Calling it directly exercises the real
// business logic without standing up a transport.
async function callDisputeTask(
  args: {
    payment_request_id: string;
    evidence_bundle?: string;
    reason?: string;
  },
  callerWallet: string,
) {
  const { createMcpServer } = await import("@/lib/mcp/server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools["dispute_task"];
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("dispute_task MCP tool (CC-092 / ADR-0001 D2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateTaskStatus.mockResolvedValue(undefined);
  });

  it("requires authentication", async () => {
    const { createMcpServer } = await import("@/lib/mcp/server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createMcpServer() as any;
    const result = await server._registeredTools["dispute_task"].handler({
      payment_request_id: "pr_1",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("Authentication required");
  });

  it("refuses a caller who is neither party", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      OTHER_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("party");
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("allows the WORKER to dispute — either party, not agent-only", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockComputeAndSignVerdict.mockResolvedValue({
      verdict: { ...FAILING_VERDICT },
      signature: "0xsig",
      checks: [{ check: "min_artefacts", passed: false }],
    });

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE, reason: "photos fail EXIF check" },
      WORKER_WALLET,
    );
    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
    expect(json.verdict.passed).toBe(false);
    expect(json.verdict.expiry).toBe("1700003600"); // bigint as string
    expect(json.signature).toBe("0xsig");
    expect(json.task_id_bytes32).toBe("0xtaskid-pr_1");
  });

  it("still allows the hiring agent", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockComputeAndSignVerdict.mockResolvedValue({
      verdict: { ...FAILING_VERDICT },
      signature: "0xsig",
      checks: [],
    });

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      AGENT_WALLET,
    );
    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
  });

  it("refuses a dispute whose verdict passes", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockComputeAndSignVerdict.mockResolvedValue({
      verdict: { ...FAILING_VERDICT, passed: true },
      signature: "0xsig",
      checks: [{ check: "min_artefacts", passed: true }],
    });

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      AGENT_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("Cannot dispute: verdict passed");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("surfaces a VerdictInputError to the caller instead of swallowing it", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    const { VerdictInputError } = await import("@/lib/contracts/verdict-service");
    mockComputeAndSignVerdict.mockRejectedValue(
      new VerdictInputError("bundle does not hash to the on-chain commitment"),
    );

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      AGENT_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("does not hash");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("refuses a bare-assertion dispute — no bundle, chain not Disputed", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Delivered" });

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", reason: "I assert the work is bad" },
      AGENT_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("signed failing verdict");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("records a dispute that already happened on-chain, without a bundle", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockGetOnChainTask.mockResolvedValue({ state: "Disputed" });

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1" },
      WORKER_WALLET,
    );
    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(json.on_chain_submitted).toBe(true);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("rejects a task whose DB status is terminal", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask({ status: "completed" }));

    const { result, json } = await callDisputeTask(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      AGENT_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("cannot dispute");
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });
});
