import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpServer } from "@/lib/mcp/server";

const mockGetTaskByPaymentId = vi.fn();
const mockUpdateTaskStatus = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
}));

vi.mock("@/lib/contracts/escrow", () => ({
  getEscrowConfig: () => ({
    address: "0xEscrow00000000000000000000000000000000",
    chainId: 84532,
    chainName: "Base Sepolia",
  }),
  toTaskId: (id: string) => `0xtaskid-${id}`,
  getOnChainTask: vi.fn(),
  getTaskResolvedOutcome: vi.fn(),
}));

const mockIssueSignedVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict-service", () => ({
  issueSignedVerdictForTask: (...args: unknown[]) => mockIssueSignedVerdict(...args),
  VerdictServiceError: class extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
    }
  },
}));

const mockVerifyPresentedVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict-signer", () => ({
  verifyPresentedVerdict: (...args: unknown[]) => mockVerifyPresentedVerdict(...args),
  serializeVerdict: (v: unknown) => v,
}));

const WORKER_WALLET = "0xWORKERworkerWORKERworkerWORKERworkerWORK".toLowerCase();
const AGENT_WALLET = "0xAGENTagentAGENTagentAGENTagentAGENTagent".toLowerCase();
const OTHER_WALLET = "0x1234567890abcdef1234567890abcdef12345678".toLowerCase();

const SIGNED = {
  verdict: {
    taskId: "0xtaskid-pr_1",
    specHash: `0x${"1".repeat(64)}`,
    evidenceHash: `0x${"2".repeat(64)}`,
    checkerHash: `0x${"3".repeat(64)}`,
    passed: true,
    breakdownHash: `0x${"0".repeat(64)}`,
    expiry: "1800003600",
    nonce: "42",
  },
  digest: "0xdigest",
  signature: "0xsig",
  signer: "0xsigner",
};

// The MCP SDK stores each registered tool's raw callback on
// `_registeredTools[name].handler` — same pattern as mcp-request-human-work.test.ts.
async function callTool(name: string, args: Record<string, unknown>, callerWallet: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer({ callerWallet }) as any;
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

function taskRow() {
  return {
    payment_request_id: "pr_1",
    to_human_wallet: WORKER_WALLET,
    from_agent_wallet: AGENT_WALLET,
    status: "active",
    amount_usdc: 10,
    spec_hash: `0x${"1".repeat(64)}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIssueSignedVerdict.mockResolvedValue(SIGNED);
  mockVerifyPresentedVerdict.mockResolvedValue({
    ok: true,
    digest: "0xdigest",
    signer: "0xsigner",
  });
});

describe("get_signed_verdict MCP tool (CC-092)", () => {
  it("requires an authenticated session", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { result, json } = await callTool(
      "get_signed_verdict",
      { payment_request_id: "pr_1", passed: true },
      null,
    );
    expect(result.isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(mockIssueSignedVerdict).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not a party to the task", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { result, json } = await callTool(
      "get_signed_verdict",
      { payment_request_id: "pr_1", passed: true },
      OTHER_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("Not authorized");
    expect(mockIssueSignedVerdict).not.toHaveBeenCalled();
  });

  it("serves a passing verdict to the worker, bound by the service", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { result, json } = await callTool(
      "get_signed_verdict",
      { payment_request_id: "pr_1", passed: true },
      WORKER_WALLET,
    );
    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.signature).toBe("0xsig");
    expect(mockIssueSignedVerdict).toHaveBeenCalledWith({
      paymentRequestId: "pr_1",
      passed: true,
      failureReason: undefined,
    });
  });

  it("serves a failing verdict to the hiring agent", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { json } = await callTool(
      "get_signed_verdict",
      { payment_request_id: "pr_1", passed: false, failure_reason: "no GPS in EXIF" },
      AGENT_WALLET,
    );
    expect(json.ok).toBe(true);
    expect(mockIssueSignedVerdict).toHaveBeenCalledWith({
      paymentRequestId: "pr_1",
      passed: false,
      failureReason: "no GPS in EXIF",
    });
  });

  it("surfaces a service refusal as an error result, not a throw", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    mockIssueSignedVerdict.mockRejectedValue(
      Object.assign(new Error("Task on-chain state is Funded"), {
        code: "not_delivered",
      }),
    );
    const { result, json } = await callTool(
      "get_signed_verdict",
      { payment_request_id: "pr_1", passed: true },
      WORKER_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Funded");
  });
});

describe("dispute_task MCP tool (CC-092 — signed-verdict disputes)", () => {
  const FAILING = {
    ...SIGNED.verdict,
    passed: false,
  };

  function disputeArgs(overrides: Record<string, unknown> = {}) {
    return {
      payment_request_id: "pr_1",
      reason: "The delivered work misses the committed spec",
      verdict: FAILING,
      signature: `0x${"ab".repeat(65)}`,
      ...overrides,
    };
  }

  it("requires authentication", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { result } = await callTool("dispute_task", disputeArgs(), null);
    expect(result.isError).toBe(true);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not a party", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { json } = await callTool("dispute_task", disputeArgs(), OTHER_WALLET);
    expect(json.ok).toBe(false);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("refuses a verdict that fails validation — no DB update (bare-assertion refusal)", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    mockVerifyPresentedVerdict.mockResolvedValue({
      ok: false,
      reason: "Verdict is passing — a failing signed verdict is required to dispute",
    });
    const { result, json } = await callTool("dispute_task", disputeArgs(), AGENT_WALLET);
    expect(result.isError).toBe(true);
    expect(json.error).toContain("Verdict refused");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("validates the verdict as failing and bound to this task", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    await callTool("dispute_task", disputeArgs(), AGENT_WALLET);
    expect(mockVerifyPresentedVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRequestId: "pr_1",
        requirePassing: false,
      }),
    );
  });

  it("records the dispute for the agent and points at the on-chain call", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    mockUpdateTaskStatus.mockResolvedValue(undefined);
    const { result, json } = await callTool("dispute_task", disputeArgs(), AGENT_WALLET);
    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(json.verdict_digest).toBe("0xdigest");
    expect(json.note).toContain("disputeTask(taskId, verdict, signature)");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
  });

  it("records the dispute for the worker too — either party (ADR-0001 D2)", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    const { json } = await callTool("dispute_task", disputeArgs(), WORKER_WALLET);
    expect(json.ok).toBe(true);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
  });
});
