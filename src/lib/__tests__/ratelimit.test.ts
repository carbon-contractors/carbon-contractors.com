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

// ── CC-020: Upstash REST path ────────────────────────────────────────────────
//
// The limiter the middleware and MCP surfaces delegate to is Upstash-backed when
// UPSTASH_REDIS_REST_URL/_TOKEN are set. These tests stub global fetch to a
// fake Upstash REST endpoint and verify the wire protocol (pipeline INCR+EXPIRE,
// Bearer auth) and the fail-open behaviour on transport errors.

describe("ratelimit — Upstash REST path (CC-020)", () => {
  let calls: Array<{ url: string; auth: string | null; body: unknown }>;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-db.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the Upstash limiter when env vars are configured", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          auth: init?.headers ? (init.headers as Record<string, string>).Authorization : null,
          body: JSON.parse(String(init?.body)),
        });
        requestCount++;
        return new Response(JSON.stringify([{ result: requestCount }]), {
          status: 200,
        });
      }),
    );

    const { apiRateLimiter } = await import("@/lib/ratelimit");

    // First request under the limit
    let result = await apiRateLimiter.limit("upstash-ip");
    expect(result.success).toBe(true);

    result = await apiRateLimiter.limit("upstash-ip");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(58);

    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://fake-db.upstash.io/pipeline");
    expect(calls[0].auth).toBe("Bearer fake-token");
    expect(Array.isArray(calls[0].body)).toBe(true);
    // Pipeline shape: INCR then EXPIRE
    expect(calls[0].body).toEqual([
      ["INCR", "api:upstash-ip"],
      ["EXPIRE", "api:upstash-ip", "60"],
    ]);
  });

  it("blocks past the limit and reports the window as Retry-After", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ url: _url, auth: null, body: JSON.parse(String(init?.body)) });
        requestCount++;
        return new Response(JSON.stringify([{ result: requestCount }]), {
          status: 200,
        });
      }),
    );

    const { challengeRateLimiter } = await import("@/lib/ratelimit");

    // Challenge bucket is 10/min
    for (let i = 0; i < 10; i++) {
      const r = await challengeRateLimiter.limit("upstash-blocked-ip");
      expect(r.success).toBe(true);
    }

    const blocked = await challengeRateLimiter.limit("upstash-blocked-ip");
    expect(blocked.success).toBe(false);
    expect(blocked.retryAfterS).toBe(60);
  });

  it("prefixes keys per limiter, so buckets do not collide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ url: _url, auth: null, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify([{ result: 1 }]), { status: 200 });
      }),
    );

    const { apiRateLimiter, challengeRateLimiter } = await import("@/lib/ratelimit");

    await apiRateLimiter.limit("same-ip");
    await challengeRateLimiter.limit("same-ip");

    const keys = calls.map((c) => (c.body as string[][])[0][1]);
    expect(keys).toEqual(["api:same-ip", "challenge:same-ip"]);
  });

  it("fails open when Upstash is unreachable — no outage-induced lockout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const { apiRateLimiter } = await import("@/lib/ratelimit");

    // Every call fails at the transport layer; the limiter must allow traffic
    // rather than turning an Upstash outage into a full API outage.
    for (let i = 0; i < 100; i++) {
      const r = await apiRateLimiter.limit("outage-ip");
      expect(r.success).toBe(true);
    }
  });

  it("treats a non-2xx Upstash response as an error and fails open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited by provider", { status: 429 })),
    );

    const { apiRateLimiter } = await import("@/lib/ratelimit");

    const r = await apiRateLimiter.limit("provider-limited-ip");
    expect(r.success).toBe(true);
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
