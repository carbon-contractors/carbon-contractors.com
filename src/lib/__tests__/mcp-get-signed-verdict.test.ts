import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTaskByPaymentId = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
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

const PASSING_VERDICT = {
  taskId: "0x" + "11".repeat(32),
  specHash: "0x" + "aa".repeat(32),
  evidenceHash: "0x" + "bb".repeat(32),
  checkerHash: "0x" + "33".repeat(32),
  passed: true,
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

async function callGetSignedVerdict(
  args: { payment_request_id: string; evidence_bundle: string },
  callerWallet: string | undefined,
) {
  const { createMcpServer } = await import("@/lib/mcp/server");
  const server = createMcpServer(
    callerWallet ? { callerWallet } : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
  const tool = server._registeredTools["get_signed_verdict"];
  const result = await tool.handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("get_signed_verdict MCP tool (CC-092)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeAndSignVerdict.mockResolvedValue({
      verdict: { ...PASSING_VERDICT },
      signature: "0xsig",
      checks: [{ check: "min_artefacts", passed: true }],
    });
  });

  it("requires authentication", async () => {
    const { result, json } = await callGetSignedVerdict(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("Authentication required");
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("404s an unknown task", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(null);
    const { result, json } = await callGetSignedVerdict(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      WORKER_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toBe("Task not found");
  });

  it("refuses a caller who is neither party", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    const { result, json } = await callGetSignedVerdict(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      OTHER_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("party");
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("returns the signed verdict and checks to the worker", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    const { result, json } = await callGetSignedVerdict(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      WORKER_WALLET,
    );
    expect(result.isError).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(mockComputeAndSignVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ payment_request_id: "pr_1" }),
      EVIDENCE_BUNDLE,
    );
    expect(json.verdict.passed).toBe(true);
    expect(json.verdict.expiry).toBe("1700003600"); // bigint as string
    expect(json.verdict.nonce).toBe("42");
    expect(json.signature).toBe("0xsig");
    expect(json.checks).toEqual([{ check: "min_artefacts", passed: true }]);
    expect(json.next_step).toContain("claimWithVerdict");
  });

  it("returns a failing verdict to the agent too — the platform signs what it found", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockComputeAndSignVerdict.mockResolvedValue({
      verdict: { ...PASSING_VERDICT, passed: false },
      signature: "0xsig",
      checks: [{ check: "min_artefacts", passed: false }],
    });

    const { result, json } = await callGetSignedVerdict(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      AGENT_WALLET,
    );
    expect(result.isError).toBeUndefined();
    expect(json.verdict.passed).toBe(false);
    expect(json.next_step).toContain("disputeTask");
  });

  it("surfaces a VerdictInputError to the caller", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    const { VerdictInputError } = await import("@/lib/contracts/verdict-service");
    mockComputeAndSignVerdict.mockRejectedValue(
      new VerdictInputError("Task has not been delivered yet"),
    );

    const { result, json } = await callGetSignedVerdict(
      { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      WORKER_WALLET,
    );
    expect(result.isError).toBe(true);
    expect(json.error).toContain("not been delivered");
  });
});
