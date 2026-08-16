/**
 * ratelimit.ts
 * NOR-179: Rate limiting with Upstash Redis support and in-memory fallback.
 *
 * When UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are configured,
 * uses distributed Redis-backed rate limiting that works across serverless instances.
 * Falls back to in-memory sliding window when Upstash is not configured.
 */

import { getRateLimitConfig } from "@/lib/config";
import { log } from "@/lib/logging";

// ── Types ────────────────────────────────────────────────────────────────────

interface RateLimitResult {
  success: boolean;
  remaining: number;
  retryAfterS: number;
}

interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>;
}

// ── In-memory fallback ───────────────────────────────────────────────────────

interface WindowEntry {
  count: number;
  windowStart: number;
}

function createInMemoryLimiter(maxRequests: number, windowMs: number): RateLimiter {
  const map = new Map<string, WindowEntry>();

  return {
    async limit(key: string): Promise<RateLimitResult> {
      const now = Date.now();
      const entry = map.get(key);

      if (!entry || now - entry.windowStart > windowMs) {
        map.set(key, { count: 1, windowStart: now });
        return { success: true, remaining: maxRequests - 1, retryAfterS: 0 };
      }

      entry.count++;

      if (entry.count > maxRequests) {
        const retryAfterS = Math.ceil(
          (entry.windowStart + windowMs - now) / 1000,
        );
        return { success: false, remaining: 0, retryAfterS };
      }

      return {
        success: true,
        remaining: maxRequests - entry.count,
        retryAfterS: 0,
      };
    },
  };
}

// ── Upstash Redis limiter ────────────────────────────────────────────────────

function createUpstashLimiter(
  maxRequests: number,
  windowMs: number,
  prefix: string,
): RateLimiter {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;

  return {
    async limit(key: string): Promise<RateLimitResult> {
      const redisKey = `${prefix}:${key}`;
      const windowS = Math.ceil(windowMs / 1000);

      try {
        // Use Upstash REST API directly — no extra dependency needed
        const pipeline = [
          ["INCR", redisKey],
          ["EXPIRE", redisKey, String(windowS)],
        ];

        const res = await fetch(`${url}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(pipeline),
        });

        if (!res.ok) {
          throw new Error(`Upstash responded ${res.status}`);
        }

        const results = await res.json() as Array<{ result: number }>;
        const count = results[0]?.result ?? 1;

        if (count > maxRequests) {
          return { success: false, remaining: 0, retryAfterS: windowS };
        }

        return {
          success: true,
          remaining: maxRequests - count,
          retryAfterS: 0,
        };
      } catch (err) {
        // If Upstash is unreachable, fail open (allow the request)
        log("warn", "upstash_ratelimit_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { success: true, remaining: maxRequests, retryAfterS: 0 };
      }
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createLimiter(
  maxRequests: number,
  windowMs: number,
  prefix: string,
): RateLimiter {
  const hasUpstash =
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

  if (hasUpstash) {
    return createUpstashLimiter(maxRequests, windowMs, prefix);
  }

  return createInMemoryLimiter(maxRequests, windowMs);
}

// ── Exported limiters ────────────────────────────────────────────────────────

// Read once, at module scope, through the validated boundary rather than through
// `parseInt(process.env.X ?? "...")` (CC-096). The old form could not see a
// set-but-empty variable — `??` does not catch "", and `parseInt("", 10)` is NaN, so
// `count > maxRequests` was false for every count and this limiter stopped limiting
// entirely. It did not fall back to 60. → Lessons-Learned §26
const rateLimits = getRateLimitConfig();

/** General API rate limiter: 60 req/min per IP (configurable via env). */
export const apiRateLimiter = createLimiter(
  rateLimits.RATE_LIMIT_MAX_REQUESTS,
  rateLimits.RATE_LIMIT_WINDOW_MS,
  "api",
);

/** MCP endpoint rate limiter: 30 req/min per IP. */
export const mcpRateLimiter = createLimiter(30, 60_000, "mcp");

/** Challenge endpoint rate limiter: 10 req/min per IP. */
export const challengeRateLimiter = createLimiter(10, 60_000, "challenge");

/**
 * Task-creation rate limiter: 30 tasks/hour, keyed on the **authenticated caller
 * wallet** rather than the IP (CC-081 Defect 4).
 *
 * The authentication is the control here; this is a bound on how fast one
 * authenticated agent can grow the tasks table. 30/hour is far past anything this
 * marketplace sees pre-launch, and `TASK_CREATE_LIMIT_PER_HOUR` exists for when it
 * is not. Note CC-020: without Upstash configured this is per-instance in-memory,
 * so on Vercel the effective limit is 30/hour × live instances.
 */
export const taskCreationRateLimiter = createLimiter(
  rateLimits.TASK_CREATE_LIMIT_PER_HOUR,
  3_600_000,
  "task-create",
);

export type { RateLimitResult, RateLimiter };
