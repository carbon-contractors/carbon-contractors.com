/**
 * retry.ts (CC-095)
 * Bounded backoff for transient delivery failures.
 *
 * "A webhook that 500s must not silently drop the only signal a worker gets"
 * (CC-095). So transient failures — 5xx, 429, timeout, network fault — are retried
 * a bounded number of times with exponential backoff. Bounded matters as much as
 * the retry itself: delivery runs inline in the request path on Vercel (CC-095 open
 * item, decided inline for v1), so an unbounded loop would spend the function's
 * wall-clock budget on one dead webhook while its siblings wait.
 *
 * When the retries are exhausted the outcome record says so and delivery.ts logs it
 * at error level — permanent failure is visible, never silent (ADR-0003 reasoning
 * applied to delivery).
 */

import type { HttpResult } from "./http";

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Backoff for attempt n is backoffBaseMs * 2^(n-1). */
  backoffBaseMs: number;
  /** Per-attempt fetch timeout. */
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffBaseMs: 500,
  timeoutMs: 10_000,
};

export function resolvePolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...partial };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` until it succeeds, the policy is exhausted, or it reports a permanent
 * failure. Returns the last result with the attempt count attached.
 */
export async function withRetries(
  fn: () => Promise<HttpResult>,
  policy: RetryPolicy,
): Promise<HttpResult & { attempts: number }> {
  let result = await fn();
  let attempts = 1;
  while (!result.ok && result.transient && attempts < policy.maxAttempts) {
    await sleep(policy.backoffBaseMs * 2 ** (attempts - 1));
    result = await fn();
    attempts += 1;
  }
  return { ...result, attempts };
}
