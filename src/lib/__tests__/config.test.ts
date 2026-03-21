import { describe, it, expect, vi, beforeEach } from "vitest";
import { getConfig, _resetConfig } from "@/lib/config";

const VALID_ENV: Record<string, string> = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  NEXT_PUBLIC_ONCHAINKIT_API_KEY: "test-api-key",
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
