import { describe, it, expect, vi, beforeEach } from "vitest";
import { getConfig, _resetConfig } from "@/lib/config";

const VALID_ENV = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  NEXT_PUBLIC_ONCHAINKIT_API_KEY: "test-api-key",
  NEXT_PUBLIC_BASE_NETWORK: "testnet",
  NEXT_PUBLIC_USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

describe("config", () => {
  beforeEach(() => {
    _resetConfig();
    vi.unstubAllEnvs();
  });

  it("validates successfully with required env vars", () => {
    for (const [key, val] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, val);
    }
    const config = getConfig();
    expect(config.SUPABASE_URL).toBe("https://test.supabase.co");
    expect(config.NEXT_PUBLIC_BASE_NETWORK).toBe("testnet");
  });

  it("throws when required vars are missing", () => {
    // Don't set any env vars
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("uses default values for optional vars", () => {
    for (const [key, val] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, val);
    }
    const config = getConfig();
    expect(config.SESSION_TIMEOUT_MS).toBe(1_800_000);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(60);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(config.MAX_SESSIONS).toBe(100);
    expect(config.NEXT_PUBLIC_BASE_URL).toBe("http://localhost:3000");
  });

  it("throws when NEXT_PUBLIC_BASE_NETWORK is not set", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { NEXT_PUBLIC_BASE_NETWORK: _omit, ...envWithout } = VALID_ENV;
    for (const [key, val] of Object.entries(envWithout)) {
      vi.stubEnv(key, val);
    }
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("throws when NEXT_PUBLIC_USDC_ADDRESS is not set", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { NEXT_PUBLIC_USDC_ADDRESS: _omit, ...envWithout } = VALID_ENV;
    for (const [key, val] of Object.entries(envWithout)) {
      vi.stubEnv(key, val);
    }
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is not set", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...envWithout } = VALID_ENV;
    for (const [key, val] of Object.entries(envWithout)) {
      vi.stubEnv(key, val);
    }
    expect(() => getConfig()).toThrow("Invalid environment configuration");
  });

  it("coerces numeric env vars from strings", () => {
    for (const [key, val] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, val);
    }
    vi.stubEnv("SESSION_TIMEOUT_MS", "5000");
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "120");
    const config = getConfig();
    expect(config.SESSION_TIMEOUT_MS).toBe(5000);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(120);
  });
});
