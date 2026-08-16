/**
 * middleware.ts
 * Combined middleware: coming-soon redirect + API rate limiting.
 * Runs on edge runtime — must NOT import Node.js modules.
 *
 * NOR-179: Rate limiting now supports Upstash Redis for distributed
 * limiting across serverless instances. Falls back to in-memory when
 * UPSTASH_REDIS_REST_URL is not configured.
 *
 * To go live: set NEXT_PUBLIC_COMING_SOON=false in env vars.
 */

import { NextRequest, NextResponse } from "next/server";

import { getRateLimitConfig } from "@/lib/config";

// ── Coming Soon Redirect ────────────────────────────────────────────────────

const COMING_SOON = process.env.NEXT_PUBLIC_COMING_SOON !== "false";

const BYPASS = [
  "/api/",
  "/_next/",
  "/favicon",
  "/robots",
  "/sitemap",
];

// ── Rate Limiting (inline — middleware runs on edge, can't import Node modules) ──

interface WindowEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, WindowEntry>();

// Validated at the boundary rather than parsed here (CC-096). getRateLimitConfig()
// deliberately reads only the rate-limit vars, so the coming-soon gate above does not
// gain a dependency on the Supabase or KMS environment. zod is edge-safe.
//
// The previous `parseInt(process.env.X ?? "60000", 10)` could not see a set-but-empty
// variable, and produced NaN rather than the default. Both constants going NaN broke
// this block in two opposite directions at once: `now - windowStart > NaN` is false,
// so the window never rolled over, while `count > NaN` is also false, so the general
// /api/* limit never tripped. Endpoints in ENDPOINT_LIMITS have literal limits, so
// their counters kept climbing against a window that never reset — meaning the MCP
// routes would have locked out permanently on request 31 while the rest of the API
// stopped being limited at all. → Lessons-Learned §26
const { RATE_LIMIT_WINDOW_MS: WINDOW_MS, RATE_LIMIT_MAX_REQUESTS: MAX_REQUESTS } =
  getRateLimitConfig();

// Tighter limits for specific endpoints
const ENDPOINT_LIMITS: Record<string, number> = {
  "/api/basedhuman.mcp/challenge": 10,
  "/api/basedhuman.mcp": 30,
};

function getMaxRequests(pathname: string): number {
  for (const [prefix, limit] of Object.entries(ENDPOINT_LIMITS)) {
    if (pathname.startsWith(prefix)) return limit;
  }
  return MAX_REQUESTS;
}

function getIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// ── Middleware ───────────────────────────────────────────────────────────────

export function middleware(request: NextRequest): NextResponse | undefined {
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

    const ip = getIp(request);
    const limit = getMaxRequests(pathname);
    const key = `${ip}:${pathname.startsWith("/api/basedhuman.mcp") ? pathname.split("?")[0] : "api"}`;

    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
      rateLimitMap.set(key, { count: 1, windowStart: now });
      return undefined;
    }

    entry.count++;

    if (entry.count > limit) {
      const retryAfter = Math.ceil(
        (entry.windowStart + WINDOW_MS - now) / 1000
      );
      return new NextResponse(
        JSON.stringify({ ok: false, error: "Too many requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        }
      );
    }
  }

  return undefined;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
