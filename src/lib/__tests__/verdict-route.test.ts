import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallengeSignature(...args),
}));

const mockGetTaskByPaymentId = vi.fn();
vi.mock("@/lib/db/tasks", () => ({
  getTaskByPaymentId: (...args: unknown[]) => mockGetTaskByPaymentId(...args),
}));

vi.mock("@/lib/contracts/escrow", () => ({
  toTaskId: (id: string) => `0xtaskid-${id}`,
}));

const mockIssueSignedVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict-service", () => {
  class VerdictServiceError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
    }
  }
  return {
    VerdictServiceError,
    VERDICT_SERVICE_ERRORS: {
      TASK_NOT_FOUND: "task_not_found",
      NOT_DELIVERED: "not_delivered",
      CHAIN_UNAVAILABLE: "chain_unavailable",
      MISSING_FAILURE_REASON: "missing_failure_reason",
    },
    issueSignedVerdictForTask: (...args: unknown[]) => mockIssueSignedVerdict(...args),
  };
});

// The mocked module's class — `instanceof` in the route must see this same
// reference, so rejections are built from it rather than Object.assign on Error.
const { VerdictServiceError } = await import("@/lib/contracts/verdict-service");

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT_WALLET = "0x2222222222222222222222222222222222222222";
const OTHER_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const SIGNED = {
  verdict: {
    taskId: "0xtaskid-pr_1",
    specHash: "0xspec",
    evidenceHash: "0xevid",
    checkerHash: "0xchk",
    passed: true,
    breakdownHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expiry: "1800003600",
    nonce: "42",
  },
  digest: "0xdigest",
  signature: "0xsig",
  signer: "0xsigner",
};

function makeRequest(opts: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  return new Request("http://localhost/api/verdict", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-caller-wallet": WORKER_WALLET,
      "x-caller-signature": "0xsig",
      "x-caller-nonce": "nonce",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(
      opts.body ?? { payment_request_id: "pr_1", passed: true },
    ),
  }) as unknown as NextRequest;
}

const AUTHED = {
  "x-caller-wallet": WORKER_WALLET,
  "x-caller-signature": "0xsig",
  "x-caller-nonce": "nonce",
};

function taskRow() {
  return {
    payment_request_id: "pr_1",
    to_human_wallet: WORKER_WALLET,
    from_agent_wallet: AGENT_WALLET,
    status: "active",
  };
}

describe("POST /api/verdict (CC-092)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    mockIssueSignedVerdict.mockResolvedValue(SIGNED);
  });

  it("rejects an unsigned request with 401", async () => {
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(
      makeRequest({ headers: { "x-caller-wallet": "", "x-caller-signature": "", "x-caller-nonce": "" } }),
    );
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a failed challenge signature with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("bad sig"));
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("rejects a non-party with 403", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ headers: AUTHED }));
    expect(res.status).toBe(403);
    expect(mockIssueSignedVerdict).not.toHaveBeenCalled();
  });

  it("serves a passing verdict to the worker", async () => {
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ body: { payment_request_id: "pr_1", passed: true } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verdict).toEqual(SIGNED.verdict);
    expect(json.signature).toBe("0xsig");
    expect(mockIssueSignedVerdict).toHaveBeenCalledWith({
      paymentRequestId: "pr_1",
      passed: true,
      failureReason: undefined,
    });
  });

  it("serves a failing verdict to the hiring agent — either party may ask", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(AGENT_WALLET);
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(
      makeRequest({
        headers: { ...AUTHED, "x-caller-wallet": AGENT_WALLET },
        body: { payment_request_id: "pr_1", passed: false, failure_reason: "no GPS in EXIF" },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockIssueSignedVerdict).toHaveBeenCalledWith({
      paymentRequestId: "pr_1",
      passed: false,
      failureReason: "no GPS in EXIF",
    });
  });

  it("returns 404 when the service cannot find the task", async () => {
    mockIssueSignedVerdict.mockRejectedValue(
      new VerdictServiceError("Task not found", "task_not_found"),
    );
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the work is not delivered on-chain", async () => {
    mockIssueSignedVerdict.mockRejectedValue(
      new VerdictServiceError("Task on-chain state is Funded", "not_delivered"),
    );
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(409);
  });

  it("returns 400 when a failing verdict is requested without a reason", async () => {
    mockIssueSignedVerdict.mockRejectedValue(
      new VerdictServiceError("A failure reason is required", "missing_failure_reason"),
    );
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ body: { payment_request_id: "pr_1", passed: false } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed body", async () => {
    const { POST } = await import("@/app/api/verdict/route");
    const res = await POST(makeRequest({ body: { passed: "yes please" } }));
    expect(res.status).toBe(400);
    expect(mockIssueSignedVerdict).not.toHaveBeenCalled();
  });
});
