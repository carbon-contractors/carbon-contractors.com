import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
