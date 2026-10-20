import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// CC-036: GET /api/attestation/completion — auth, input and the error mapping.
// The signing itself is covered in src/lib/attestation/__tests__/completion.test.ts.

const mockSessionWallet = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  sessionWalletFromRequest: (...args: unknown[]) => mockSessionWallet(...args),
}));

const mockVerifyChallengeSignature = vi.fn();
vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyChallengeSignature: (...args: unknown[]) => mockVerifyChallengeSignature(...args),
}));

const mockSign = vi.fn();
vi.mock("@/lib/attestation/completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attestation/completion")>();
  return { ...actual, signCompletionAttestation: (...a: unknown[]) => mockSign(...a) };
});

import { CompletionAttestationError } from "@/lib/attestation/completion";

const WORKER = "0x1234567890abcdef1234567890abcdef12345678";
const PR_ID = "a".repeat(32);

function req(query: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/attestation/completion${query}`, {
    method: "GET",
    headers,
  }) as unknown as NextRequest;
}

describe("GET /api/attestation/completion (CC-036)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionWallet.mockResolvedValue(WORKER);
    mockSign.mockResolvedValue({ sig: { uid: `0x${"11".repeat(32)}` }, signer: "0xsigner" });
  });

  it("401s with no session and no challenge headers, without signing", async () => {
    mockSessionWallet.mockResolvedValue(null);
    const { GET } = await import("@/app/api/attestation/completion/route");
    const res = await GET(req(`?payment_request_id=${PR_ID}`));
    expect(res.status).toBe(401);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("401s when the challenge signature fails", async () => {
    mockSessionWallet.mockResolvedValue(null);
    mockVerifyChallengeSignature.mockRejectedValue(new Error("bad"));
    const { GET } = await import("@/app/api/attestation/completion/route");
    const res = await GET(
      req(`?payment_request_id=${PR_ID}`, {
        "x-caller-wallet": WORKER,
        "x-caller-signature": "0xsig",
        "x-caller-nonce": "n",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("400s on a malformed payment_request_id", async () => {
    const { GET } = await import("@/app/api/attestation/completion/route");
    const res = await GET(req("?payment_request_id=nope"));
    expect(res.status).toBe(400);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("passes the authenticated caller as the required worker", async () => {
    const { GET } = await import("@/app/api/attestation/completion/route");
    const res = await GET(req(`?payment_request_id=${PR_ID}`));
    expect(res.status).toBe(200);
    expect(mockSign).toHaveBeenCalledWith(PR_ID, WORKER);
    expect((await res.json()).attestation.sig.uid).toBe(`0x${"11".repeat(32)}`);
  });

  it("403s for a caller who is not the on-chain worker", async () => {
    mockSign.mockRejectedValue(new CompletionAttestationError("not worker", "forbidden"));
    const { GET } = await import("@/app/api/attestation/completion/route");
    const res = await GET(req(`?payment_request_id=${PR_ID}`));
    expect(res.status).toBe(403);
  });

  it("409s for a task that has not paid its worker", async () => {
    mockSign.mockRejectedValue(new CompletionAttestationError("not yet", "not_completed"));
    const { GET } = await import("@/app/api/attestation/completion/route");
    const res = await GET(req(`?payment_request_id=${PR_ID}`));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not_completed");
  });
});
