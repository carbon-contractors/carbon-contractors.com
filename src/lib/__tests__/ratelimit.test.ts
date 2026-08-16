import { describe, it, expect, vi, beforeEach } from "vitest";

// Suppress log output
vi.mock("@/lib/logging", () => ({
  log: vi.fn(),
}));

describe("ratelimit", () => {
  beforeEach(() => {
    vi.resetModules();
    // Ensure no Upstash env vars for in-memory tests
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("creates in-memory limiter when Upstash is not configured", async () => {
    const { apiRateLimiter } = await import("@/lib/ratelimit");
    const result = await apiRateLimiter.limit("test-ip");
    expect(result.success).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("tracks requests per key", async () => {
    const { challengeRateLimiter } = await import("@/lib/ratelimit");

    // Challenge limit is 10/min
    for (let i = 0; i < 10; i++) {
      const result = await challengeRateLimiter.limit("same-ip");
      expect(result.success).toBe(true);
    }

    // 11th should fail
    const blocked = await challengeRateLimiter.limit("same-ip");
    expect(blocked.success).toBe(false);
    expect(blocked.retryAfterS).toBeGreaterThan(0);
  });

  it("isolates different keys", async () => {
    const { challengeRateLimiter } = await import("@/lib/ratelimit");

    // Exhaust limit for ip-a
    for (let i = 0; i < 11; i++) {
      await challengeRateLimiter.limit("ip-a");
    }

    // ip-b should still be fine
    const result = await challengeRateLimiter.limit("ip-b");
    expect(result.success).toBe(true);
  });
});

// ── CC-097 ───────────────────────────────────────────────────────────────────
//
// The regression these exist for: `parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ??
// "60", 10)` could not see a set-but-empty variable. `parseInt("", 10)` is NaN, and
// `entry.count > NaN` is false for every count — so a blank field in the Vercel
// dashboard silently disabled the general /api/* limiter entirely. It did not fall
// back to 60.

describe("ratelimit — blank env vars (CC-097)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("still limits when RATE_LIMIT_MAX_REQUESTS is present but empty", async () => {
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "");

    const { apiRateLimiter } = await import("@/lib/ratelimit");

    // The documented default is 60/min. Pre-fix this loop ran to 61 with every
    // request succeeding, because NaN made the comparison unreachable.
    for (let i = 0; i < 60; i++) {
      const result = await apiRateLimiter.limit("blank-env-ip");
      expect(result.success).toBe(true);
    }

    const blocked = await apiRateLimiter.limit("blank-env-ip");
    expect(blocked.success).toBe(false);
    expect(blocked.retryAfterS).toBeGreaterThan(0);
  });

  it("reports a numeric remaining count, never NaN", async () => {
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "");

    const { apiRateLimiter } = await import("@/lib/ratelimit");
    const result = await apiRateLimiter.limit("nan-check-ip");

    expect(Number.isNaN(result.remaining)).toBe(false);
    expect(result.remaining).toBe(59);
  });

  it("still limits task creation when TASK_CREATE_LIMIT_PER_HOUR is blank", async () => {
    vi.stubEnv("TASK_CREATE_LIMIT_PER_HOUR", "");

    const { taskCreationRateLimiter } = await import("@/lib/ratelimit");

    // Documented default is 30/hour, keyed on the authenticated wallet (CC-081 D4).
    for (let i = 0; i < 30; i++) {
      const result = await taskCreationRateLimiter.limit("0xwallet");
      expect(result.success).toBe(true);
    }

    const blocked = await taskCreationRateLimiter.limit("0xwallet");
    expect(blocked.success).toBe(false);
  });

  it("refuses to start with a malformed limit rather than running permissive", async () => {
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "unlimited");
    await expect(import("@/lib/ratelimit")).rejects.toThrow(
      "Invalid environment configuration",
    );
  });
});
