import { describe, it, expect } from "vitest";
import {
  validateDiscoveryConfig,
  DISCOVERY_ENV_NAMES,
} from "../discovery-config.mjs";
import {
  DISCOVERY_CASES,
  DISCOVERY_CASE_FLAG_LIST,
  selectDiscoveryCase,
} from "../discovery-cases.mjs";
import { parseDiscoveryArgs } from "../discovery-args.mjs";

// CC-060: hermetic. Everything imported here is pure — no client construction,
// no fetch, no env reads outside the objects passed in explicitly.

const GOOD_ENV = {
  DISCOVERY_WALLET_PRIVATE_KEY: "0x" + "b".repeat(64),
  NEXT_PUBLIC_BASE_URL: "https://www.carbon-contractors.com",
};

// ── config validation ────────────────────────────────────────────────────────

describe("validateDiscoveryConfig (CC-032)", () => {
  it("reports EVERY missing item at once, not one at a time", () => {
    const result = validateDiscoveryConfig({});
    expect(result.ok).toBe(false);
    const message = result.problems.join("\n");
    expect(message).toContain(DISCOVERY_ENV_NAMES.walletKey);
    expect(message).toContain(DISCOVERY_ENV_NAMES.baseUrl);
    expect(result.problems).toHaveLength(2);
  });

  it("treats a blank var as missing, not configured (CC-097)", () => {
    const result = validateDiscoveryConfig({
      ...GOOD_ENV,
      DISCOVERY_WALLET_PRIVATE_KEY: "",
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("is not set");
  });

  it("rejects a malformed private key without ever echoing its value", () => {
    const bad = "0xnotakey";
    const result = validateDiscoveryConfig({
      ...GOOD_ENV,
      DISCOVERY_WALLET_PRIVATE_KEY: bad,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("malformed");
    expect(result.problems.join("\n")).not.toContain(bad);
  });

  it("does not require the wallet key when an ephemeral wallet was requested", () => {
    const result = validateDiscoveryConfig(
      { NEXT_PUBLIC_BASE_URL: GOOD_ENV.NEXT_PUBLIC_BASE_URL },
      { ephemeralWallet: true },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an env pointed at mainnet — discovery reads the testnet deployment", () => {
    const result = validateDiscoveryConfig({
      ...GOOD_ENV,
      NEXT_PUBLIC_BASE_NETWORK: "mainnet",
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("testnet");
  });

  it("accepts a good env and strips the base URL's trailing slash", () => {
    const result = validateDiscoveryConfig({
      ...GOOD_ENV,
      NEXT_PUBLIC_BASE_URL: "https://www.carbon-contractors.com/",
    });
    expect(result.ok).toBe(true);
    expect(result.config.baseUrl).toBe("https://www.carbon-contractors.com");
  });

  it("never carries the private key in the resolved config", () => {
    const result = validateDiscoveryConfig(GOOD_ENV);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.config)).not.toContain("bbbb");
  });

  it("mentions the www host in the missing-base-URL message (apex answers 307)", () => {
    const result = validateDiscoveryConfig({ DISCOVERY_WALLET_PRIVATE_KEY: GOOD_ENV.DISCOVERY_WALLET_PRIVATE_KEY });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("www.carbon-contractors.com");
  });
});

// ── case registry ────────────────────────────────────────────────────────────

describe("discovery case registry (CC-032)", () => {
  it("systematic is the default case with no flag", () => {
    const { caseKey, caseDef } = selectDiscoveryCase([]);
    expect(caseKey).toBe("systematic");
    expect(caseDef.kind).toBe("systematic");
  });

  it("rejects two case flags in one run", () => {
    expect(() => selectDiscoveryCase(["alreadyRegistered", "profileUpdate"])).toThrow(/one case flag/);
  });

  it("every case declares an assertClean outcome", () => {
    for (const [key, c] of Object.entries(DISCOVERY_CASES)) {
      expect(c.assertClean, `${key} must declare assertClean`).toBeTruthy();
      expect(c.title, `${key} must have a title`).toBeTruthy();
    }
  });

  it("flag list matches the registry's flagged cases", () => {
    expect(DISCOVERY_CASE_FLAG_LIST).toEqual(
      Object.values(DISCOVERY_CASES)
        .filter((c) => c.flag)
        .map((c) => c.flag),
    );
  });
});

// ── args ─────────────────────────────────────────────────────────────────────

describe("parseDiscoveryArgs (CC-032)", () => {
  it("defaults to dry-run mode, no case, env wallet", () => {
    const parsed = parseDiscoveryArgs([]);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.execute).toBe(false);
    expect(parsed.generateWallet).toBe(false);
    expect(parsed.caseKeys).toEqual([]);
  });

  it("parses mode + wallet + case flags", () => {
    const parsed = parseDiscoveryArgs(["--execute", "--generate-wallet", "--case-already-registered"]);
    expect(parsed.execute).toBe(true);
    expect(parsed.generateWallet).toBe(true);
    expect(parsed.caseKeys).toEqual(["alreadyRegistered"]);
  });

  it("rejects unknown flags with every problem listed", () => {
    expect(() => parseDiscoveryArgs(["--execute", "--frobnicate", "--nope=1"])).toThrow(/frobnicate.*nope=1|nope=1.*frobnicate/);
  });

  it("rejects --dry-run and --execute together", () => {
    expect(() => parseDiscoveryArgs(["--dry-run", "--execute"])).toThrow(/mutually exclusive/);
  });
});
