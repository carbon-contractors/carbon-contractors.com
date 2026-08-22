import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockGetTaskByPaymentId = vi.fn();
const mockUpdateTaskStatus = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallengeSignature(...args),
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

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
    to_human_wallet: WORKER_WALLET,
    from_agent_wallet: AGENT_WALLET,
    status: "active",
    amount_usdc: 10,
    acceptance_spec: '{"schema_version":1,"criteria":{}}',
    spec_hash: "0x" + "aa".repeat(32),
    spec_schema_version: 1,
    funded_at: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

function failingComputed(overrides: Record<string, unknown> = {}) {
  return {
    verdict: { ...FAILING_VERDICT },
    signature: "0xsignedsignedsignedsignedsignedsignedsignedsignedsignedsignedsigned",
    checks: [{ check: "min_artefacts", passed: false }],
    ...overrides,
  };
}

function makeRequest(opts: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  return new Request("http://localhost/api/dispute", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify(opts.body ?? { payment_request_id: "pr_1" }),
  }) as unknown as NextRequest;
}

function authHeaders(wallet: string) {
  return {
    "x-caller-wallet": wallet,
    "x-caller-signature": "0xsig",
    "x-caller-nonce": "nonce",
  };
}

describe("POST /api/dispute (CC-004 auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unsigned request with 401", async () => {
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a request whose signature fails verification with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("Signature does not match claimed wallet"));
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a validly-signed request from a wallet that is neither party with 403", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({ headers: authHeaders(OTHER_WALLET) }));
    expect(res.status).toBe(403);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("still enforces the task status guard for an authorized party", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(baseTask({ status: "completed" }));

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(WORKER_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(409);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/dispute with an evidence bundle (CC-092 / ADR-0001 D2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockUpdateTaskStatus.mockResolvedValue(undefined);
  });

  it("marks the task disputed and returns the signed failing verdict for the worker", async () => {
    mockComputeAndSignVerdict.mockResolvedValue(failingComputed());

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(WORKER_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(mockComputeAndSignVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ payment_request_id: "pr_1" }),
      EVIDENCE_BUNDLE,
    );
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
    expect(json.verdict.passed).toBe(false);
    expect(json.verdict.expiry).toBe("1700003600"); // bigint serialised as a string
    expect(json.signature).toBe(
      "0xsignedsignedsignedsignedsignedsignedsignedsignedsignedsignedsigned",
    );
    expect(json.checks).toEqual([{ check: "min_artefacts", passed: false }]);
    expect(json.task_id_bytes32).toBe("0xtaskid-pr_1");
  });

  it("allows the hiring agent too — either party may dispute", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(AGENT_WALLET);
    mockComputeAndSignVerdict.mockResolvedValue(failingComputed());

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(AGENT_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
  });

  it("rejects with 400 when the verdict passes — a pass is a reason not to dispute", async () => {
    mockComputeAndSignVerdict.mockResolvedValue(
      failingComputed({
        verdict: { ...FAILING_VERDICT, passed: true },
        checks: [{ check: "min_artefacts", passed: true }],
      }),
    );

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(WORKER_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Cannot dispute: verdict passed");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("passes a VerdictInputError through as 409 — the caller can fix the input", async () => {
    const { VerdictInputError } = await import("@/lib/contracts/verdict-service");
    mockComputeAndSignVerdict.mockRejectedValue(
      new VerdictInputError("bundle does not hash to the on-chain commitment"),
    );

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(WORKER_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(409);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("500s an unexpected verdict-service failure rather than leaking it", async () => {
    mockComputeAndSignVerdict.mockRejectedValue(new Error("RPC exploded"));

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(WORKER_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(500);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("does not rewrite the status when the DB already says disputed", async () => {
    mockGetTaskByPaymentId.mockResolvedValue(baseTask({ status: "disputed" }));
    mockComputeAndSignVerdict.mockResolvedValue(failingComputed());

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: authHeaders(WORKER_WALLET),
        body: { payment_request_id: "pr_1", evidence_bundle: EVIDENCE_BUNDLE },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/dispute without an evidence bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(baseTask());
    mockUpdateTaskStatus.mockResolvedValue(undefined);
  });

  it("records a dispute that already happened on-chain", async () => {
    mockGetOnChainTask.mockResolvedValue({ state: "Disputed" });

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(json.on_chain_submitted).toBe(true);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("refuses a bare-assertion dispute — 400, nothing written", async () => {
    mockGetOnChainTask.mockResolvedValue({ state: "Delivered" });

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("signed failing verdict");
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("refuses just as firmly when the chain is unreadable — never guess", async () => {
    mockGetOnChainTask.mockRejectedValue(new Error("RPC down"));

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));
    expect(res.status).toBe(400);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });
});
