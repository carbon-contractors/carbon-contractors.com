/**
 * middleware.ts
 * Combined middleware: coming-soon redirect + API rate limiting.
 * Runs on edge runtime — must NOT import Node.js modules.
 *
 * To go live: remove the COMING_SOON redirect block below.
 */

import { NextRequest, NextResponse } from "next/server";

// ── Coming Soon Redirect ────────────────────────────────────────────────────

const COMING_SOON = true; // flip to false (or delete this block) to go live

const BYPASS = [
  "/api/",
  "/_next/",
  "/favicon",
  "/robots",
  "/sitemap",
];

// ── Rate Limiting ───────────────────────────────────────────────────────────

interface WindowEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, WindowEntry>();

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? "60", 10);

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

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown";

    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
      rateLimitMap.set(ip, { count: 1, windowStart: now });
      return undefined;
    }

    entry.count++;

    if (entry.count > MAX_REQUESTS) {
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
