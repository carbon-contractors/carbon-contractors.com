import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Stub env vars before importing middleware
vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "3");
vi.stubEnv("RATE_LIMIT_WINDOW_MS", "60000");

// We need to test the middleware function — root middleware.ts (not src/)
let middleware: (req: NextRequest) => ReturnType<typeof import("../../../middleware").middleware>;

describe("rate limiting middleware", () => {
  beforeEach(async () => {
    vi.resetModules();
    // Re-import to get fresh state (root middleware.ts)
    const mod = await import("../../../middleware");
    middleware = mod.middleware;
  });

  it("allows requests under the limit", () => {
    const req = new NextRequest("http://localhost:3000/api/tasks", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const result = middleware(req);
    expect(result).toBeUndefined();
  });

  it("returns 429 when limit exceeded", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 3; i++) {
      const req = new NextRequest("http://localhost:3000/api/tasks", {
        headers: { "x-forwarded-for": ip },
      });
      middleware(req);
    }
    // 4th request should be blocked
    const req = new NextRequest("http://localhost:3000/api/tasks", {
      headers: { "x-forwarded-for": ip },
    });
    const result = middleware(req);
    expect(result?.status).toBe(429);
  });

  it("exempts /api/health from rate limiting", () => {
    const req = new NextRequest("http://localhost:3000/api/health", {
      headers: { "x-forwarded-for": "5.5.5.5" },
    });
    const result = middleware(req);
    expect(result).toBeUndefined();
  });

  it("tracks different IPs independently", () => {
    // Max out IP A
    for (let i = 0; i < 3; i++) {
      const req = new NextRequest("http://localhost:3000/api/tasks", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      middleware(req);
    }
    // IP B should still work
    const req = new NextRequest("http://localhost:3000/api/tasks", {
      headers: { "x-forwarded-for": "10.0.0.3" },
    });
    const result = middleware(req);
    expect(result).toBeUndefined();
  });

  it("applies tighter limits to MCP challenge endpoint", () => {
    // Challenge endpoint has a limit of 10, but env stubs set MAX_REQUESTS=3.
    // The per-endpoint limit for /api/basedhuman.mcp/challenge is 10,
    // which is higher than the stubbed 3, but the endpoint map takes precedence.
    // With RATE_LIMIT_MAX_REQUESTS=3, the general limit is 3.
    // The challenge endpoint override is 10, so it should allow more than 3.
    const ip = "10.0.0.50";
    // First 3 requests should pass (general limit would block at 4th)
    for (let i = 0; i < 3; i++) {
      const req = new NextRequest(
        "http://localhost:3000/api/basedhuman.mcp/challenge",
        { headers: { "x-forwarded-for": ip } },
      );
      const result = middleware(req);
      expect(result).toBeUndefined();
    }
    // 4th request: general API would block, but challenge endpoint allows up to 10
    const req = new NextRequest(
      "http://localhost:3000/api/basedhuman.mcp/challenge",
      { headers: { "x-forwarded-for": ip } },
    );
    const result = middleware(req);
    expect(result).toBeUndefined();
  });
});

// ── CC-096 ───────────────────────────────────────────────────────────────────
//
// Blank RATE_LIMIT_* vars broke this middleware in two opposite directions at once.
// WINDOW_MS = NaN meant `now - windowStart > NaN` was false, so the window never
// rolled over; MAX_REQUESTS = NaN meant `count > NaN` was false, so the general
// /api/* limit never tripped. ENDPOINT_LIMITS holds *literal* limits, though, so
// those kept comparing against a counter that could never reset — the MCP routes
// would have locked out permanently while the rest of the API went unlimited.

describe("rate limiting middleware — blank env vars (CC-096)", () => {
  let middleware: (req: NextRequest) => ReturnType<typeof import("../../../middleware").middleware>;

  const request = (path: string, ip: string) =>
    new NextRequest(`http://localhost:3000${path}`, {
      headers: { "x-forwarded-for": ip },
    });

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("RATE_LIMIT_MAX_REQUESTS", "");
    vi.stubEnv("RATE_LIMIT_WINDOW_MS", "");
    const mod = await import("../../../middleware");
    middleware = mod.middleware;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("falls back to the documented 60/min instead of not limiting at all", () => {
    const ip = "203.0.113.1";
    for (let i = 0; i < 60; i++) {
      expect(middleware(request("/api/tasks", ip))).toBeUndefined();
    }
    expect(middleware(request("/api/tasks", ip))?.status).toBe(429);
  });

  it("rolls the window over, so a tighter endpoint limit is not a permanent lockout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));

    const ip = "203.0.113.2";
    const path = "/api/basedhuman.mcp/challenge";

    // ENDPOINT_LIMITS caps this at 10 regardless of RATE_LIMIT_MAX_REQUESTS.
    for (let i = 0; i < 10; i++) {
      expect(middleware(request(path, ip))).toBeUndefined();
    }
    expect(middleware(request(path, ip))?.status).toBe(429);

    // Past the 60s default window the counter must reset. With WINDOW_MS = NaN the
    // comparison at middleware.ts:86 was false forever and this stayed 429.
    vi.advanceTimersByTime(61_000);
    expect(middleware(request(path, ip))).toBeUndefined();
  });

  it("sends a numeric Retry-After, never the string NaN", () => {
    const ip = "203.0.113.3";
    for (let i = 0; i < 60; i++) middleware(request("/api/tasks", ip));

    const blocked = middleware(request("/api/tasks", ip));
    const retryAfter = blocked?.headers.get("Retry-After");

    expect(retryAfter).not.toBeNull();
    expect(retryAfter).not.toBe("NaN");
    expect(Number.isFinite(Number(retryAfter))).toBe(true);
  });
});
