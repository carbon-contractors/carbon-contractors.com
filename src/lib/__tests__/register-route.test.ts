import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifyMessage = vi.fn();
vi.mock("viem", () => ({
  verifyMessage: (...args: unknown[]) => mockVerifyMessage(...args),
}));

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

const MIXED_CASE_WALLET = "0xAbCdEf1234567890aBcDeF1234567890ABCDEF12";
const LOWER_WALLET = MIXED_CASE_WALLET.toLowerCase();

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.insert = vi.fn().mockResolvedValue(result);
  chain.upsert = vi.fn().mockResolvedValue(result);
  chain.delete = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.lt = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result)));
  return chain;
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    categories: ["cleaning"],
    rate_usdc: 50,
    nonce: "abcdefgh12345678",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("POST /api/register (CC-002 wallet casing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyMessage.mockResolvedValue(true);
  });

  it("normalizes a mixed-case wallet to lowercase before writing to humans and used_nonces", async () => {
    const deleteChain = chainable({ data: null, error: null });
    const nonceCheckChain = chainable({ data: null, error: null }); // no existing nonce
    const nonceInsertChain = chainable({ data: null, error: null });
    const humansUpsertChain = chainable({ data: null, error: null });

    mockFrom
      .mockReturnValueOnce(deleteChain) // used_nonces.delete (purge stale)
      .mockReturnValueOnce(nonceCheckChain) // used_nonces.select...single
      .mockReturnValueOnce(nonceInsertChain) // used_nonces.insert
      .mockReturnValueOnce(humansUpsertChain); // humans.upsert

    const message = JSON.stringify(validPayload());
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.wallet).toBe(LOWER_WALLET);

    expect(nonceInsertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: LOWER_WALLET }),
    );
    expect(humansUpsertChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: LOWER_WALLET }),
      { onConflict: "wallet" },
    );

    // Verification itself must use the original (signed) casing, not the lowercased one.
    expect(mockVerifyMessage).toHaveBeenCalledWith(
      expect.objectContaining({ address: MIXED_CASE_WALLET }),
    );
  });

  it("rejects an invalid signature regardless of wallet casing", async () => {
    mockVerifyMessage.mockResolvedValue(false);
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({
        message: JSON.stringify(validPayload()),
        signature: "0xbadsig",
        wallet: MIXED_CASE_WALLET,
      }),
    );

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
