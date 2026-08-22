import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTaskByPaymentId = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallengeSignature(...args),
}));

const mockComputeAndSignVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contracts/verdict-service")>();
  return {
    ...actual,
    computeAndSignVerdict: (...args: unknown[]) => mockComputeAndSignVerdict(...args),
  };
});

vi.mock("@/lib/logging", () => ({ log: vi.fn() }));

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const TASK = {
  id: "1",
  payment_request_id: "pr_1",
  from_agent_wallet: AGENT_WALLET,
  to_human_wallet: WORKER_WALLET,
  task_description: "do the thing",
  amount_usdc: 10,
  deadline_unix: 0,
  status: "active",
  tx_hash: null,
  escrow_contract: null,
  acceptance_spec: '{"schema_version":1,"criteria":{}}',
  spec_hash: "0x" + "ab".repeat(32),
  spec_schema_version: 1,
  funded_at: "2026-08-20T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
};

function authHeaders(wallet: string) {
  return {
    "x-caller-wallet": wallet,
    "x-caller-signature": "0xsig",
    "x-caller-nonce": "nonce",
    "Content-Type": "application/json",
  };
}

function makeRequest(opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new NextRequest("http://localhost/api/verdict", {
    method: "POST",
    headers: opts.headers ?? authHeaders(WORKER_WALLET),
    body: JSON.stringify(opts.body ?? { payment_request_id: "pr_1", evidence_bundle: "{}" }),
  });
}

describe("POST /api/verdict (CC-092)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskByPaymentId.mockResolvedValue(TASK);
    mockComputeAndSignVerdict.mockResolvedValue({
      verdict: {
        taskId: "0x" + "11".repeat(32),
        specHash: TASK.spec_hash,
        evidenceHash: "0x" + "22".repeat(32),
        checkerHash: "0x" + "33".repeat(32),
        passed: true,
        breakdownHash: "0x" + "44".repeat(32),
        expiry: BigInt(1_700_003_600),
        nonce: BigInt(42),
      },
      signature: "0xsignedsignedsignedsignedsignedsignedsignedsignedsignedsignedsigned",
      checks: [{ check: "min_artefacts", passed: true }],
    });
  });

  it("401s without a signature", async () => {
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: { "Content-Type": "application/json" } }));

    expect(res.status).toBe(401);
    expect(mockVerifyChallengeSignature).not.toHaveBeenCalled();
  });

  it("401s when the signature does not verify", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("bad sig"));

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
  });

  it("404s an unknown task", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(null);

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest());

    expect(res.status).toBe(404);
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("403s a caller who is neither the worker nor the agent", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: authHeaders(OTHER_WALLET) }));

    expect(res.status).toBe(403);
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("allows the worker and returns the signed verdict", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verdict.passed).toBe(true);
    expect(json.verdict.expiry).toBe("1700003600"); // bigint serialised as a string
    expect(json.signature).toBe(
      "0xsignedsignedsignedsignedsignedsignedsignedsignedsignedsignedsigned",
    );
    expect(mockComputeAndSignVerdict).toHaveBeenCalledWith(TASK, "{}");
  });

  it("allows the hiring agent too — a verdict is not worker-only", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(AGENT_WALLET);

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: authHeaders(AGENT_WALLET) }));

    expect(res.status).toBe(200);
  });

  it("400s a missing evidence_bundle", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(
      makeRequest({ headers: authHeaders(WORKER_WALLET), body: { payment_request_id: "pr_1" } }),
    );

    expect(res.status).toBe(400);
    expect(mockComputeAndSignVerdict).not.toHaveBeenCalled();
  });

  it("409s a VerdictInputError from the service — the caller can fix it", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    const { VerdictInputError } = await import("@/lib/contracts/verdict-service");
    mockComputeAndSignVerdict.mockRejectedValue(
      new VerdictInputError("evidence bundle does not hash to the on-chain commitment"),
    );

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("does not hash");
  });

  it("500s an unexpected failure rather than leaking it verbatim", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockComputeAndSignVerdict.mockRejectedValue(new Error("RPC exploded"));

    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: authHeaders(WORKER_WALLET) }));

    expect(res.status).toBe(500);
  });
});
