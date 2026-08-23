import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isWalletSanctioned,
  normalizeWalletAddress,
  _resetSanctionsCacheForTests,
} from "@/lib/sanctions";
import { SANCTIONED_ADDRESSES } from "@/lib/sanctions/data";

// A real, currently-listed OFAC SDN address (Lazarus Group / Ronin Bridge attacker)
// from the bundled dataset — the local control must work with no network and no key.
const LISTED_WALLET = SANCTIONED_ADDRESSES[0].address;
const CLEAN_WALLET = "0x1111222233334444555566667777888899990000";

describe("normalizeWalletAddress (CC-099)", () => {
  it("lowercases a valid mixed-case address", () => {
    expect(
      normalizeWalletAddress("0xAbCdEf1234567890aBcDeF1234567890ABCDEF12"),
    ).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
  });

  it.each([
    "0x123", // too short
    "1234567890abcdef1234567890abcdef12345678", // no 0x prefix
    "0xgggggggggggggggggggggggggggggggggggggggg", // not hex
    "", // empty
    "not an address at all",
  ])("rejects %j", (input) => {
    expect(normalizeWalletAddress(input)).toBeNull();
  });
});

describe("isWalletSanctioned — bundled dataset (CC-099)", () => {
  beforeEach(() => {
    _resetSanctionsCacheForTests();
    vi.unstubAllEnvs();
  });

  it("matches a listed address, lowercased and normalised", async () => {
    const result = await isWalletSanctioned(LISTED_WALLET);
    expect(result.sanctioned).toBe(true);
    expect(result.list).toBe("OFAC SDN");
    expect(result.reason).toBeTruthy();
  });

  it("matches regardless of the casing it is handed", async () => {
    const result = await isWalletSanctioned(LISTED_WALLET.toUpperCase());
    expect(result.sanctioned).toBe(true);
  });

  it("does not match a clean address", async () => {
    const result = await isWalletSanctioned(CLEAN_WALLET);
    expect(result.sanctioned).toBe(false);
    expect(result.list).toBeUndefined();
  });

  it("never throws on a non-address input — screening is not the shape validator", async () => {
    const result = await isWalletSanctioned("garbage");
    expect(result.sanctioned).toBe(false);
  });
});

describe("isWalletSanctioned — in-memory cache (CC-099)", () => {
  beforeEach(() => {
    _resetSanctionsCacheForTests();
    vi.unstubAllEnvs();
  });

  it("answers a repeat lookup from cache without another dataset/provider pass", async () => {
    const first = await isWalletSanctioned(LISTED_WALLET);
    const second = await isWalletSanctioned(LISTED_WALLET.toUpperCase());
    expect(second).toEqual(first);
    // Distinct object identity is not required; equal verdicts from any casing are.
    expect(second.sanctioned).toBe(true);
  });
});

describe("isWalletSanctioned — optional provider layer (CC-099)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    _resetSanctionsCacheForTests();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call the provider when no API key is configured", async () => {
    await isWalletSanctioned(CLEAN_WALLET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a provider match as sanctioned", async () => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "test-key");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ address: CLEAN_WALLET, sanctioned: true }), {
        status: 200,
      }),
    );

    const result = await isWalletSanctioned(CLEAN_WALLET);

    expect(result.sanctioned).toBe(true);
    expect(result.list).toBe("chainalysis");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(CLEAN_WALLET),
      expect.objectContaining({ headers: { "X-API-KEY": "test-key" } }),
    );
  });

  it("caches a provider verdict so a repeat lookup makes no second call", async () => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "test-key");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ address: CLEAN_WALLET, sanctioned: false }), {
        status: 200,
      }),
    );

    await isWalletSanctioned(CLEAN_WALLET);
    await isWalletSanctioned(CLEAN_WALLET);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still blocks on the bundled dataset even when the provider is unconfigured — layers are independent", async () => {
    await isWalletSanctioned(LISTED_WALLET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-ok status", () => new Response("nope", { status: 503 })],
    ["a network fault", () => Promise.reject(new Error("ECONNRESET"))],
    [
      "an unrecognised response shape",
      () => new Response(JSON.stringify({ totally: "unexpected" }), { status: 200 }),
    ],
  ])("fails open with a logged warning on %s — the dataset result stands", async (_label, makeResp) => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "test-key");
    fetchMock.mockImplementationOnce(makeResp);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await isWalletSanctioned(CLEAN_WALLET);

    expect(result.sanctioned).toBe(false);
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("sanctions_provider_api_error");
    consoleSpy.mockRestore();
  });

  it("a listed dataset address is blocked even while the provider is erroring", async () => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "test-key");
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    // Dataset hit short-circuits before the provider is ever consulted.
    const result = await isWalletSanctioned(LISTED_WALLET);
    expect(result.sanctioned).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries the provider on the next call after an indeterminate response (not cached)", async () => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "test-key");
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ totally: "unexpected" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sanctioned: true }), { status: 200 }),
      );

    const first = await isWalletSanctioned(CLEAN_WALLET);
    const second = await isWalletSanctioned(CLEAN_WALLET);

    expect(first.sanctioned).toBe(false);
    expect(second.sanctioned).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
