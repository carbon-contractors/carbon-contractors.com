import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { maskWallet } from "@/lib/logging";

const mockVerifyWalletSignature = vi.fn();
vi.mock("@/lib/wallet/verify", () => ({
  verifyWalletSignature: (...args: unknown[]) => mockVerifyWalletSignature(...args),
}));

const mockFrom = vi.fn();
vi.mock("@/lib/db/client", () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}));

const mockRegisterNotificationChannel = vi.fn();
vi.mock("@/lib/db/notifications", () => ({
  registerNotificationChannel: (...args: unknown[]) =>
    mockRegisterNotificationChannel(...args),
}));

// CC-099: the real module is hermetic without a provider key, but mocking keeps these
// tests about the enforcement wiring. Default: not sanctioned.
const mockIsWalletSanctioned = vi.fn();
vi.mock("@/lib/sanctions", () => ({
  isWalletSanctioned: (...args: unknown[]) => mockIsWalletSanctioned(...args),
}));

const MIXED_CASE_WALLET = "0xAbCdEf1234567890aBcDeF1234567890ABCDEF12";
const LOWER_WALLET = MIXED_CASE_WALLET.toLowerCase();
const HUMAN_ID = "11111111-1111-1111-1111-111111111111";

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.insert = vi.fn().mockResolvedValue(result);
  // Real code chains .upsert(...).select("id").single()
  chain.upsert = vi.fn(self);
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

/** Sets up the standard used_nonces (delete/select/insert) + humans.upsert chain sequence. */
function stubHappyPathChain() {
  const deleteChain = chainable({ data: null, error: null });
  const nonceCheckChain = chainable({ data: null, error: null }); // no existing nonce
  const nonceInsertChain = chainable({ data: null, error: null });
  const humansUpsertChain = chainable({ data: { id: HUMAN_ID }, error: null });

  mockFrom
    .mockReturnValueOnce(deleteChain) // used_nonces.delete (purge stale)
    .mockReturnValueOnce(nonceCheckChain) // used_nonces.select...single
    .mockReturnValueOnce(nonceInsertChain) // used_nonces.insert
    .mockReturnValueOnce(humansUpsertChain); // humans.upsert().select("id").single()

  return { deleteChain, nonceCheckChain, nonceInsertChain, humansUpsertChain };
}

describe("POST /api/register (CC-002 wallet casing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });
  });

  it("normalizes a mixed-case wallet to lowercase before writing to humans and used_nonces", async () => {
    const { nonceInsertChain, humansUpsertChain } = stubHappyPathChain();

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
    expect(mockVerifyWalletSignature).toHaveBeenCalledWith(
      expect.objectContaining({ address: MIXED_CASE_WALLET }),
    );
  });

  it("rejects an invalid signature regardless of wallet casing", async () => {
    mockVerifyWalletSignature.mockResolvedValue(false);
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

describe("POST /api/register (CC-005 contact capture)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });
    mockRegisterNotificationChannel.mockResolvedValue({ id: "chan-1" });
  });

  it("registers an email notification channel keyed off the new human row", async () => {
    stubHappyPathChain();

    const message = JSON.stringify(
      validPayload({ contact_email: "  Worker@Example.com  " }),
    );
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(200);
    expect(mockRegisterNotificationChannel).toHaveBeenCalledWith({
      contractor_id: HUMAN_ID,
      type: "email",
      address: "worker@example.com",
      accepts_auto_booking: false,
    });
  });

  it("skips notification channel registration when contact_email is omitted", async () => {
    stubHappyPathChain();

    const message = JSON.stringify(validPayload());
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(200);
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects an invalid contact_email format", async () => {
    const message = JSON.stringify(validPayload({ contact_email: "not-an-email" }));
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRegisterNotificationChannel).not.toHaveBeenCalled();
  });

  it("still registers the worker if the notification channel write fails (best-effort)", async () => {
    stubHappyPathChain();
    mockRegisterNotificationChannel.mockRejectedValue(new Error("insert failed"));

    const message = JSON.stringify(
      validPayload({ contact_email: "worker@example.com" }),
    );
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("never logs the raw contact email address", async () => {
    stubHappyPathChain();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const email = "worker@example.com";
    const message = JSON.stringify(validPayload({ contact_email: email }));
    const { POST } = await import("@/app/api/register/route");

    await POST(makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }));

    const loggedText = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(loggedText).not.toContain(email);

    consoleSpy.mockRestore();
  });
});

describe("POST /api/register (CC-022 rate validation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });
  });

  async function postRate(rate: number) {
    const message = JSON.stringify(validPayload({ rate_usdc: rate }));
    const { POST } = await import("@/app/api/register/route");
    return POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );
  }

  it.each([-50, 0])("rejects a non-positive rate (%s) with a 400", async (rate) => {
    const res = await postRate(rate);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/greater than zero/i);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects a rate above the sane maximum instead of 500ing on NUMERIC(10,2) overflow", async () => {
    const res = await postRate(1_000_000_000);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/cannot exceed 10,000 USDC/i);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects more than two decimal places instead of letting the column round silently", async () => {
    const res = await postRate(50.123);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/2 decimal places/i);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("accepts a rate with exactly two decimal places at the maximum bound", async () => {
    const { humansUpsertChain } = stubHappyPathChain();

    const res = await postRate(10_000);

    expect(res.status).toBe(200);
    expect(humansUpsertChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ rate_usdc: 10_000 }),
      { onConflict: "wallet" },
    );
  });

  it("accepts fractional rates with one or two decimals", async () => {
    stubHappyPathChain();
    expect((await postRate(50.5)).status).toBe(200);

    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
    stubHappyPathChain();
    expect((await postRate(50.55)).status).toBe(200);
  });
});

describe("POST /api/register (CC-023 clock-skew self-diagnosis)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });
  });

  it.each([
    ["ahead of the server", 10_000],
    ["behind the server", -400],
  ])(
    "tells the worker their device clock is the problem when timestamp is %s",
    async (_label, offsetS) => {
      const message = JSON.stringify(
        validPayload({ timestamp: Math.floor(Date.now() / 1000) + offsetS }),
      );
      const { POST } = await import("@/app/api/register/route");

      const res = await POST(
        makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe(
        "Device clock is out of sync with the server. Please check your device date/time settings and enable automatic network time.",
      );
      expect(json.detail).toMatch(/ahead of|behind/);
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );
});

describe("POST /api/register (CC-099 sanctions screening)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWalletSignature.mockResolvedValue(true);
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: false });
  });

  it("screens the normalised wallet after signature verification", async () => {
    stubHappyPathChain();

    const message = JSON.stringify(validPayload());
    const { POST } = await import("@/app/api/register/route");

    await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(mockIsWalletSanctioned).toHaveBeenCalledWith(LOWER_WALLET);
    // And only after the signature was accepted — the screen cannot be probed by
    // an unauthenticated caller.
    expect(mockVerifyWalletSignature).toHaveBeenCalled();
  });

  it("rejects a sanctioned wallet with 403 and the SANCTIONED_WALLET code", async () => {
    mockIsWalletSanctioned.mockResolvedValue({
      sanctioned: true,
      list: "OFAC SDN",
      reason: "test designation",
    });

    const message = JSON.stringify(validPayload());
    const { POST } = await import("@/app/api/register/route");

    const res = await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe(
      "Wallet address is restricted under sanctions compliance.",
    );
    expect(json.code).toBe("SANCTIONED_WALLET");
  });

  it("writes nothing — no nonce consumption, no humans row — for a sanctioned wallet", async () => {
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: true, list: "OFAC SDN" });

    const message = JSON.stringify(validPayload());
    const { POST } = await import("@/app/api/register/route");

    await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("logs register_sanctioned_wallet_rejected with the wallet masked, not raw", async () => {
    mockIsWalletSanctioned.mockResolvedValue({ sanctioned: true, list: "OFAC SDN" });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const message = JSON.stringify(validPayload());
    const { POST } = await import("@/app/api/register/route");

    await POST(
      makeRequest({ message, signature: "0xsig", wallet: MIXED_CASE_WALLET }),
    );

    const rejected = consoleSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("register_sanctioned_wallet_rejected"));
    expect(rejected).toBeTruthy();
    expect(rejected).not.toContain(LOWER_WALLET);
    expect(rejected).toContain(maskWallet(LOWER_WALLET));

    consoleSpy.mockRestore();
  });
});
