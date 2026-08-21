/**
 * rpc-retry.mjs — retry a chain read that failed for infrastructure reasons.
 *
 * The invariant monitors run hourly against a public, rate-limited endpoint (`CC-048`).
 * A single transient RPC failure used to cost a Discord alert, an hour of heartbeat
 * downtime and a recovery email — for a network blip, not an invariant violation.
 * That is alert fatigue arriving exactly where `ADR-0003` warned it would: an alert
 * channel nobody reads is not an alert channel.
 *
 * Retrying here is safe because every monitor is **read-only**. There is no request in
 * this directory whose repetition can change state.
 *
 * `verify-escrow-deployment.mjs` has a near-identical helper for a different purpose —
 * read-your-writes lag straight after a deploy, where the retry is waiting for the chain
 * to catch up rather than for a flake to pass. Left separate deliberately: same shape,
 * different reason to exist, and merging them would make one of the two comments a lie.
 */

/** Errors worth retrying: transport, rate limiting, timeouts. Never a revert. */
const TRANSIENT = [
  /rate.?limit/i,
  /429/,
  /timeout/i,
  /timed out/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i,
  /socket hang up/i,
  /HTTP request failed/i,
  /RPC request failed/i,
  /fetch failed/i,
  /502|503|504/,
  /service unavailable/i,
  /internal error/i,
];

export function isTransient(err) {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT.some((re) => re.test(text));
}

/**
 * Run `fn`, retrying only transient failures with exponential backoff.
 *
 * A non-transient error throws immediately — a revert or a bad address is a real finding
 * and retrying it just delays the alert by a minute.
 *
 * @param {string} label shown in the retry notice so the log says what was retried
 * @param {() => Promise<T>} fn
 * @param {{attempts?: number, baseMs?: number, log?: (s: string) => void}} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRpcRetry(label, fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1500;
  const log = opts.log ?? ((s) => process.stdout.write(s));

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts) throw err;
      const waitMs = baseMs * 2 ** (i - 1);
      log(`   ${label}: transient RPC failure, retry ${i}/${attempts - 1} in ${waitMs}ms\n`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/** First line of an error, for a one-line verdict. viem messages run to a dozen lines. */
export function shortError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "unknown error";
}
