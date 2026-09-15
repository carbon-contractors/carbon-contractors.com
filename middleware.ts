/**
 * middleware.ts
 * Combined middleware: coming-soon redirect + API rate limiting.
 * Runs on edge runtime — must NOT import Node.js modules.
 *
 * CC-020: rate limiting is delegated to `@/lib/ratelimit`, which is backed by
 * Upstash Redis (distributed across serverless instances) when
 * UPSTASH_REDIS_REST_URL/_TOKEN are configured, and falls back to an in-memory
 * per-instance window when they are not. The limits themselves live there:
 * general /api/* (RATE_LIMIT_MAX_REQUESTS/min), /api/basedhuman.mcp (30/min)
 * and /api/basedhuman.mcp/challenge (10/min). This file no longer keeps a
 * private counter — one bucket, one implementation.
 *
 * To go live: set NEXT_PUBLIC_COMING_SOON=false in env vars.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  apiRateLimiter,
  challengeRateLimiter,
  mcpRateLimiter,
} from "@/lib/ratelimit";

// ── Coming Soon Redirect ────────────────────────────────────────────────────

const COMING_SOON = process.env.NEXT_PUBLIC_COMING_SOON !== "false";

const BYPASS = [
  "/api/",
  "/_next/",
  "/favicon",
  "/robots",
  "/sitemap",
];

// ── Rate Limiting ────────────────────────────────────────────────────────────
//
// Delegated to @/lib/ratelimit (CC-020). Env vars are validated at the boundary
// there, via getRateLimitConfig() — deliberately only the rate-limit vars, so
// the coming-soon gate above does not gain a dependency on the Supabase or KMS
// environment. zod is edge-safe. Blank env vars fall back to the documented
// defaults rather than disabling the limiter (CC-097 / Lessons-Learned §26).

function getIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// ── Middleware ───────────────────────────────────────────────────────────────

export async function middleware(
  request: NextRequest,
): Promise<NextResponse | undefined> {
  const { pathname } = request.nextUrl;

  // ── Coming soon: redirect non-API, non-static routes to / ──
  if (COMING_SOON) {
    const isBypassed = BYPASS.some((prefix) => pathname.startsWith(prefix));
    if (!isBypassed && pathname !== "/") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  // ── Rate limiting: only apply to /api/* routes ──
  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/health") {
      return undefined;
    }

    const limiter = pathname.startsWith("/api/basedhuman.mcp/challenge")
      ? challengeRateLimiter
      : pathname.startsWith("/api/basedhuman.mcp")
        ? mcpRateLimiter
        : apiRateLimiter;

    const { success, retryAfterS } = await limiter.limit(getIp(request));

    if (!success) {
      return new NextResponse(
        JSON.stringify({ ok: false, error: "Too many requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfterS),
          },
        },
      );
    }
  }

  return undefined;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
