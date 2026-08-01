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

const WORKER_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

  it("rejects a request with an invalid wallet header with 401", async () => {
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: {
          "x-caller-wallet": "not-a-wallet",
          "x-caller-signature": "0xsig",
          "x-caller-nonce": "nonce",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request whose signature fails verification with 401", async () => {
    mockVerifyChallengeSignature.mockRejectedValue(new Error("Signature does not match claimed wallet"));
    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: {
          "x-caller-wallet": WORKER_WALLET,
          "x-caller-signature": "0xsig",
          "x-caller-nonce": "nonce",
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(mockGetTaskByPaymentId).not.toHaveBeenCalled();
  });

  it("rejects a validly-signed request from a wallet other than the assigned worker with 403", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(OTHER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      to_human_wallet: WORKER_WALLET,
      from_agent_wallet: "0xagentagentagentagentagentagentagentagen",
      status: "active",
      amount_usdc: 10,
    });

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: {
          "x-caller-wallet": OTHER_WALLET,
          "x-caller-signature": "0xsig",
          "x-caller-nonce": "nonce",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it("accepts a validly-signed request from the assigned worker", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      to_human_wallet: WORKER_WALLET,
      from_agent_wallet: "0xagentagentagentagentagentagentagentagen",
      status: "active",
      amount_usdc: 10,
    });
    mockUpdateTaskStatus.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: {
          "x-caller-wallet": WORKER_WALLET,
          "x-caller-signature": "0xsig",
          "x-caller-nonce": "nonce",
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("disputed");
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith("pr_1", "disputed");
  });

  it("still enforces the task status guard for an authorized worker", async () => {
    mockVerifyChallengeSignature.mockResolvedValue(WORKER_WALLET);
    mockGetTaskByPaymentId.mockResolvedValue({
      payment_request_id: "pr_1",
      to_human_wallet: WORKER_WALLET,
      from_agent_wallet: "0xagentagentagentagentagentagentagentagen",
      status: "completed",
      amount_usdc: 10,
    });

    const { POST } = await import("@/app/api/dispute/route");
    const res = await POST(
      makeRequest({
        headers: {
          "x-caller-wallet": WORKER_WALLET,
          "x-caller-signature": "0xsig",
          "x-caller-nonce": "nonce",
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });
});
