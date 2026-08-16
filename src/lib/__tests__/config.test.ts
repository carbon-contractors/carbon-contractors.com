import { describe, it, expect, vi, beforeEach } from "vitest";
import { getConfig, getRateLimitConfig, _resetConfig } from "@/lib/config";

const VALID_ENV: Record<string, string> = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  NEXT_PUBLIC_BASE_NETWORK: "testnet",
  NEXT_PUBLIC_USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/** Stub all VALID_ENV keys, then delete any real env vars that CI might set. */
function stubAll(overrides: Record<string, string> = {}) {
  const merged = { ...VALID_ENV, ...overrides };
  for (const [key, val] of Object.entries(merged)) {
    vi.stubEnv(key, val);
  }
}

/** Stub env vars but explicitly remove one key (works even if CI sets it). */
function stubWithout(keyToRemove: string) {
  for (const [key, val] of Object.entries(VALID_ENV)) {
    if (key === keyToRemove) {
      // Force it to undefined so Zod sees it as missing
      delete process.env[key];
    } else {
      vi.stubEnv(key, val);
    }
  }
}

describe("config", () => {
  beforeEach(() => {
    _resetConfig();
    vi.unstubAllEnvs();
  });

  it("validates successfully with required env vars", () => {
    stubAll();
    const config = getConfig();
    expect(config.SUPABASE_URL).toBe("https://test.supabase.co");
    expect(config.NEXT_PUBLIC_BASE_NETWORK).toBe("testnet");
  });

  it("throws when required vars are missing", () => {
    // Delete all required vars that CI might set
    for (const key of Object.keys(VALID_ENV)) {
      delete process.env[key];
    }
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("uses default values for optional vars", () => {
    stubAll();
    const config = getConfig();
    expect(config.SESSION_TIMEOUT_MS).toBe(1_800_000);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(60);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(config.MAX_SESSIONS).toBe(100);
    expect(config.NEXT_PUBLIC_BASE_URL).toBe("http://localhost:3000");
  });

  it("throws when NEXT_PUBLIC_BASE_NETWORK is not set", () => {
    stubWithout("NEXT_PUBLIC_BASE_NETWORK");
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("throws when NEXT_PUBLIC_USDC_ADDRESS is not set", () => {
    stubWithout("NEXT_PUBLIC_USDC_ADDRESS");
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is not set", () => {
    stubWithout("SUPABASE_SERVICE_ROLE_KEY");
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("coerces numeric env vars from strings", () => {
    stubAll({
      SESSION_TIMEOUT_MS: "5000",
      RATE_LIMIT_MAX_REQUESTS: "120",
    });
    const config = getConfig();
    expect(config.SESSION_TIMEOUT_MS).toBe(5000);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(120);
  });
});

// ── CC-096: set-but-empty env vars ───────────────────────────────────────────
//
// A var that is present but empty arrives as "" rather than undefined. `??` does not
// catch it, `.default()` does not fire on it, and — the trap that made this worth a
// ticket — `z.coerce.number()` turns "" into 0 rather than NaN, because
// `Number("") === 0`. So the pre-fix schema answered a blank RATE_LIMIT_MAX_REQUESTS
// with a limit of zero, and a blank ESCROW_DEPLOY_BLOCK with block 0, which is a
// valid block number that passes escrow.ts's `=== undefined` guard.

describe("config — set-but-empty env vars (CC-096)", () => {
  beforeEach(() => {
    _resetConfig();
    vi.unstubAllEnvs();
  });

  it("treats a blank numeric var as unset and applies the documented default", () => {
    stubAll({ RATE_LIMIT_MAX_REQUESTS: "", RATE_LIMIT_WINDOW_MS: "" });
    const config = getConfig();
    // Not NaN (the old parseInt result) and not 0 (the old z.coerce result).
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(60);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("treats a whitespace-only numeric var as unset", () => {
    stubAll({ SESSION_TIMEOUT_MS: "   ", MAX_SESSIONS: "\t" });
    const config = getConfig();
    expect(config.SESSION_TIMEOUT_MS).toBe(1_800_000);
    expect(config.MAX_SESSIONS).toBe(100);
  });

  it("does not silently coerce a blank numeric var to zero", () => {
    stubAll({ MAX_SESSIONS: "", SESSION_TIMEOUT_MS: "" });
    const config = getConfig();
    expect(config.MAX_SESSIONS).not.toBe(0);
    expect(config.SESSION_TIMEOUT_MS).not.toBe(0);
  });

  it.each([
    ["not a number", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["fractional", "12.5"],
  ])("throws on a %s value rather than defaulting", (_label, value) => {
    stubAll({ RATE_LIMIT_MAX_REQUESTS: value });
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("names the offending variable in the error", () => {
    stubAll({ RATE_LIMIT_MAX_REQUESTS: "abc" });
    expect(() => getConfig()).toThrow(/RATE_LIMIT_MAX_REQUESTS/);
  });

  it("reads a blank ESCROW_DEPLOY_BLOCK as unset, not as block 0", () => {
    // Block 0 is a *valid* block number, so escrow.ts's `configured === undefined`
    // guard would pass and the escrow_deploy_block_unset warning would never fire —
    // scanning from genesis silently. This is the CC-070 hazard arriving quietly.
    stubAll({ ESCROW_DEPLOY_BLOCK: "" });
    expect(getConfig().ESCROW_DEPLOY_BLOCK).toBeUndefined();
  });

  it("still accepts a genuine ESCROW_DEPLOY_BLOCK of 0", () => {
    stubAll({ ESCROW_DEPLOY_BLOCK: "0" });
    expect(getConfig().ESCROW_DEPLOY_BLOCK).toBe(0);
  });

  it("reads blank optional strings as absent rather than present-and-empty", () => {
    // A blank GCP_KMS_KEY_PATH must mean "no HSM configured" — that value selects
    // the signer implementation. vitest.setup.ts deletes rather than blanks these
    // for the same reason; the schema now enforces it.
    stubAll({
      GCP_KMS_KEY_PATH: "",
      NEXT_PUBLIC_ESCROW_CONTRACT: "",
      PLATFORM_WALLET_ADDRESS: "",
    });
    const config = getConfig();
    expect(config.GCP_KMS_KEY_PATH).toBeUndefined();
    expect(config.NEXT_PUBLIC_ESCROW_CONTRACT).toBeUndefined();
    expect(config.PLATFORM_WALLET_ADDRESS).toBeUndefined();
  });

  it("applies the default for a blank NEXT_PUBLIC_BASE_URL", () => {
    stubAll({ NEXT_PUBLIC_BASE_URL: "" });
    expect(getConfig().NEXT_PUBLIC_BASE_URL).toBe("http://localhost:3000");
  });

  it("rejects a blank required var — blank is not a value", () => {
    stubAll({ SUPABASE_ANON_KEY: "" });
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });
});

describe("getRateLimitConfig (CC-096)", () => {
  beforeEach(() => {
    _resetConfig();
    vi.unstubAllEnvs();
  });

  it("does not require the rest of the environment", () => {
    // middleware.ts reads this at module scope on the edge runtime, and the same
    // middleware hosts the coming-soon gate. A missing Supabase key must not take
    // the gate down with it.
    for (const key of Object.keys(VALID_ENV)) delete process.env[key];
    expect(() => getRateLimitConfig()).not.toThrow();
    expect(getRateLimitConfig().RATE_LIMIT_MAX_REQUESTS).toBe(60);
  });

  it("applies documented defaults for blank values", () => {
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "");
    vi.stubEnv("TASK_CREATE_LIMIT_PER_HOUR", "");
    const limits = getRateLimitConfig();
    expect(limits.RATE_LIMIT_MAX_REQUESTS).toBe(60);
    expect(limits.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(limits.TASK_CREATE_LIMIT_PER_HOUR).toBe(30);
  });

  it("reads explicit values", () => {
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "5");
    vi.stubEnv("TASK_CREATE_LIMIT_PER_HOUR", "7");
    const limits = getRateLimitConfig();
    expect(limits.RATE_LIMIT_MAX_REQUESTS).toBe(5);
    expect(limits.TASK_CREATE_LIMIT_PER_HOUR).toBe(7);
  });

  it("throws on a malformed value rather than coming up permissive", () => {
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "sixty");
    expect(() => getRateLimitConfig()).toThrow("Invalid environment configuration");
  });
});
