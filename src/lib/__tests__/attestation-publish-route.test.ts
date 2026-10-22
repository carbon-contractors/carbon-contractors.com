import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// CC-036: POST /api/attestation/publish — auth, input and error mapping. Signing is
// covered in src/lib/attestation/__tests__/delegated.test.ts.

const mockSessionWallet = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  sessionWalletFromRequest: (...a: unknown[]) => mockSessionWallet(...a),
}));
vi.mock("@/lib/auth/wallet-challenge", () => ({ verifyChallengeSignature: vi.fn() }));

const mockSign = vi.fn();
vi.mock("@/lib/attestation/delegated", () => ({
  signDelegatedCompletionRequest: (...a: unknown[]) => mockSign(...a),
}));

import { CompletionAttestationError } from "@/lib/attestation/completion";
import { UnknownAttestEnvelopeError } from "@/lib/attestation/envelope";

const WORKER = "0x1234567890abcdef1234567890abcdef12345678";
const PR_ID = "b".repeat(32);

function req(body: unknown) {
  return new Request("http://localhost/api/attestation/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/attestation/publish (CC-036)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionWallet.mockResolvedValue(WORKER);
    mockSign.mockResolvedValue({ to: "0x4200000000000000000000000000000000000021", nonce: "3" });
  });

  it("401s with no session and no challenge headers, without signing", async () => {
    mockSessionWallet.mockResolvedValue(null);
    const { POST } = await import("@/app/api/attestation/publish/route");
    expect((await POST(req({ payment_request_id: PR_ID }))).status).toBe(401);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("400s on a missing, malformed or unparseable id", async () => {
    const { POST } = await import("@/app/api/attestation/publish/route");
    for (const body of [{}, { payment_request_id: "nope" }, "not json"]) {
      expect((await POST(req(body))).status).toBe(400);
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("signs for the authenticated caller as the required worker", async () => {
    const { POST } = await import("@/app/api/attestation/publish/route");
    const res = await POST(req({ payment_request_id: PR_ID }));
    expect(res.status).toBe(200);
    expect(mockSign).toHaveBeenCalledWith(PR_ID, WORKER);
    expect((await res.json()).publish.nonce).toBe("3");
  });

  it("maps forbidden to 403 and not-completed to 409", async () => {
    const { POST } = await import("@/app/api/attestation/publish/route");
    mockSign.mockRejectedValueOnce(new CompletionAttestationError("x", "forbidden"));
    expect((await POST(req({ payment_request_id: PR_ID }))).status).toBe(403);
    mockSign.mockRejectedValueOnce(new CompletionAttestationError("x", "not_completed"));
    expect((await POST(req({ payment_request_id: PR_ID }))).status).toBe(409);
  });

  it("503s, without leaking detail, when EAS reports an unknown struct", async () => {
    const { POST } = await import("@/app/api/attestation/publish/route");
    mockSign.mockRejectedValueOnce(new UnknownAttestEnvelopeError(`0x${"99".repeat(32)}`, "x"));
    const res = await POST(req({ payment_request_id: PR_ID }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/0x9999/);
  });
});
