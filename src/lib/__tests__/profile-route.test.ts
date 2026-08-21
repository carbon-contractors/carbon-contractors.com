import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifyWalletSignature = vi.fn();
vi.mock("@/lib/wallet/verify", () => ({
  verifyWalletSignature: (...args: unknown[]) => mockVerifyWalletSignature(...args),
}));

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

const mockGetHumanByWallet = vi.fn();
vi.mock("@/lib/db/whitepages", () => ({
  getHumanByWallet: (...args: unknown[]) => mockGetHumanByWallet(...args),
}));

const MIXED_CASE_WALLET = "0xAbCdEf1234567890aBcDeF1234567890ABCDEF12";
const LOWER_WALLET = MIXED_CASE_WALLET.toLowerCase();

const UPDATED_PROFILE = {
  wallet: LOWER_WALLET,
  categories: ["cleaning", "pet-services"],
  rate_usdc: 65.5,
  availability: "busy" as const,
};

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.update = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.select = vi.fn(self);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)));
  return chain;
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function signedMessage(payload: Record<string, unknown>): string {
  return JSON.stringify({
    action: "profile-update",
    wallet: MIXED_CASE_WALLET,
    timestamp: Math.floor(Date.now() / 1000),
    ...payload,
  });
}

function patchRequest(payload: Record<string, unknown>) {
  return makeRequest({
    message: signedMessage(payload),
    signature: "0xsig",
    wallet: MIXED_CASE_WALLET,
  });
}

/** Stubs the humans.update chain with a successful row return. */
function stubSuccessfulUpdate() {
  const humansUpdateChain = chainable({ data: UPDATED_PROFILE, error: null });
  mockFrom.mockReturnValueOnce(humansUpdateChain);
  return humansUpdateChain;
}

describe("PATCH /api/profile (CC-021)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
  });

  it("rejects a request with missing wallet, message, or signature", async () => {
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(makeRequest({ message: "{}", signature: "0xsig" }));

    expect(res.status).toBe(400);
    expect(mockVerifyWalletSignature).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature with 401 and never touches the database", async () => {
    mockVerifyWalletSignature.mockResolvedValue(false);
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({ availability: "busy" }));

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("returns 400 when signature verification throws (RPC failure)", async () => {
    mockVerifyWalletSignature.mockRejectedValue(new Error("RPC down"));
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({ availability: "busy" }));

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects a signed message whose embedded wallet does not match the request wallet", async () => {
    const { PATCH } = await import("@/app/api/profile/route");

    const message = JSON.stringify({
      action: "profile-update",
      wallet: "0x1111111111111111111111111111111111111111",
      timestamp: Math.floor(Date.now() / 1000),
      availability: "busy",
    });
    const res = await PATCH(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects a message signed for a different action (replay of a registration signature)", async () => {
    const { PATCH } = await import("@/app/api/profile/route");

    const message = JSON.stringify({
      categories: ["cleaning"],
      rate_usdc: 50,
      nonce: "abcdefgh12345678",
      timestamp: Math.floor(Date.now() / 1000),
    });
    const res = await PATCH(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects an expired message", async () => {
    const { PATCH } = await import("@/app/api/profile/route");

    const message = JSON.stringify({
      action: "profile-update",
      wallet: MIXED_CASE_WALLET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      availability: "busy",
    });
    const res = await PATCH(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects an update with no editable fields", async () => {
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({}));

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each(["on-holiday", "AVAILABLE", 42, null])(
    "rejects an invalid availability value (%s)",
    async (availability) => {
      const { PATCH } = await import("@/app/api/profile/route");

      const res = await PATCH(patchRequest({ availability }));

      expect(res.status).toBe(400);
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it.each([0, -5, 10_000.01, 12.345, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid rate_usdc value (%s)",
    async (rate) => {
      const { PATCH } = await import("@/app/api/profile/route");

      const res = await PATCH(patchRequest({ rate_usdc: rate }));

      expect(res.status).toBe(400);
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("accepts a rate_usdc at the 10,000 ceiling with 2 decimals", async () => {
    stubSuccessfulUpdate();
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({ rate_usdc: 10_000 }));

    expect(res.status).toBe(200);
  });

  it.each([
    ["no categories", []],
    ["too many categories", ["cleaning", "pet-services", "moving-hauling"]],
    ["unknown slug", ["not-a-category"]],
  ])("rejects invalid categories (%s)", async (_label, categories) => {
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({ categories }));

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("updates the humans row with the service role, keyed by the lowercased wallet", async () => {
    const humansUpdateChain = stubSuccessfulUpdate();
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(
      patchRequest({
        availability: "busy",
        rate_usdc: 65.5,
        categories: ["cleaning", "pet-services"],
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.profile).toEqual(UPDATED_PROFILE);

    expect(humansUpdateChain.update).toHaveBeenCalledWith({
      availability: "busy",
      rate_usdc: 65.5,
      categories: ["cleaning", "pet-services"],
    });
    expect(humansUpdateChain.eq).toHaveBeenCalledWith("wallet", LOWER_WALLET);

    // Verification must use the original (signed) casing, not the lowercased one —
    // same rule as /api/register (CC-002).
    expect(mockVerifyWalletSignature).toHaveBeenCalledWith(
      expect.objectContaining({ address: MIXED_CASE_WALLET }),
    );
  });

  it("applies only the fields present in the signed message", async () => {
    const humansUpdateChain = stubSuccessfulUpdate();
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({ availability: "offline" }));

    expect(res.status).toBe(200);
    expect(humansUpdateChain.update).toHaveBeenCalledWith({ availability: "offline" });
  });

  it("returns 404 when the wallet has no humans row", async () => {
    // .single() on a non-matching wallet errors rather than returning null
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: { message: "no rows" } }));
    const { PATCH } = await import("@/app/api/profile/route");

    const res = await PATCH(patchRequest({ availability: "busy" }));

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Worker not registered");
  });
});
