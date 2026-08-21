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

vi.mock("@/lib/contracts/escrow", () => ({
  toTaskId: (id: string) => `0xtaskid-${id}`,
}));

const mockVerifyPresentedVerdict = vi.fn();
vi.mock("@/lib/contracts/verdict-signer", () => ({
  verifyPresentedVerdict: (...args: unknown[]) => mockVerifyPresentedVerdict(...args),
}));

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT_WALLET = "0x2222222222222222222222222222222222222222";
const OTHER_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// A serialized failing verdict exactly as POST /api/verdict returns it.
const FAILING_VERDICT = {
  // Real bytes32 — the route's Zod schema validates shape before any logic runs.
  taskId: `0x${"a".repeat(64)}`,
  specHash: `0x${"1".repeat(64)}`,
  evidenceHash: `0x${"2".repeat(64)}`,
  checkerHash: `0x${"3".repeat(64)}`,
  passed: false,
  breakdownHash: `0x${"4".repeat(64)}`,
  expiry: "9999999999",
  nonce: "42",
};

const VALID_SIGNATURE = `0x${"ab".repeat(65)}`;

function makeRequest(opts: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  return new Request("http://localhost/api/dispute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-caller-wallet": WORKER_WALLET,
      "x-caller-signature": "0xsig",
      "x-caller-nonce": "nonce",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(
      opts.body ?? {
        payment_request_id: "pr_1",
        reason: "The work cannot meet the spec",
        verdict: FAILING_VERDICT,
        signature: VALID_SIGNATURE,
      },
    ),
  }) as unknown as NextRequest;
}

function taskRow() {
  return {
    payment_request_id: "pr_1",
    to_human_wallet: WORKER_WALLET,
    from_agent_wallet: AGENT_WALLET,
    status: "active",
    amount_usdc: 10,
  };
}

describe("POST /api/dispute (CC-092 — signed-verdict disputes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue(taskRow());
    mockUpdateTaskStatus.mockResolvedValue(undefined);
    mockVerifyPresentedVerdict.mockResolvedValue({
      ok: true,
      digest: "0xdigest",
      signer: "0xsigner",
    });
  });

  it("rejects an unsigned request with 401", async () => {
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: {
          "x-caller-wallet": "",
          "x-caller-signature": "",
          "x-caller-nonce": "",
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a request whose challenge signature fails with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("Signature does not match claimed wallet"));
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("refuses a bare assertion — no verdict — with 400, before touching the chain or DB", async () => {
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        body: { payment_request_id: "pr_1", reason: "I just dispute it ok" },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockVerifyPresentedVerdict).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("refuses a verdict that fails validation with 400 and does not record the dispute", async () => {
    mockVerifyPresentedVerdict.mockResolvedValue({
      ok: false,
      reason: "Verdict is passing — a failing signed verdict is required to dispute",
    });
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("rejects a validly-signed caller who is not a party to the task with 403", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({ headers: { "x-caller-wallet": OTHER_WALLET } }),
    );
    expect(res.status).toBe(403);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("records the dispute for the assigned worker with a valid failing verdict", async () => {
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(json.verdict_digest).toBe("0xdigest");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
    expect(mockVerifyPresentedVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRequestId: "pr_1",
        requirePassing: false,
        signature: VALID_SIGNATURE,
      }),
    );
  });

  it("records the dispute for the hiring agent too — either party may dispute (ADR-0001 D2)", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(AGENT_WALLET);
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({ headers: { "x-caller-wallet": AGENT_WALLET } }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
  });

  it("still enforces the task status guard for an authorized party", async () => {
    mockGetTaskByPaymentId.mockResolvedValue({ ...taskRow(), status: "completed" });
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(409);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });
});
