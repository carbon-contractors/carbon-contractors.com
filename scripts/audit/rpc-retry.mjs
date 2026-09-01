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

/**
 * Confirm the endpoint is on the chain the script thinks it is.
 *
 * ## Why this is its own check
 *
 * An RPC pointed at the wrong network does not error. It answers every call, cheerfully,
 * about a different chain — so a contract read comes back `0x` and surfaces as
 * `returned no data`, which reads as "the contract is broken" rather than "you are looking
 * at the wrong chain". Measured 2026-09-01: the same escrow address read fine over the
 * public gateway and returned no data over a freshly-added dedicated endpoint, and the
 * error text at the time suggested setting the very variable that had just been set.
 *
 * One `eth_chainId` call converts that into a sentence naming both chains.
 *
 * @returns null when it matches, or a ready-to-print explanation when it does not.
 */
export async function chainIdMismatch(client, expected, label) {
  let actual;
  try {
    actual = await client.getChainId();
  } catch {
    // Unreachable endpoints are the retry helper's problem, not this one.
    return null;
  }
  if (actual === expected) return null;

  const known = {
    1: "Ethereum mainnet",
    8453: "Base mainnet",
    84532: "Base Sepolia",
    11155111: "Ethereum Sepolia",
  };
  const name = (id) => (known[id] ? `${known[id]} (${id})` : `chain ${id}`);

  return [
    `MISCONFIGURED: the RPC endpoint is on ${name(actual)}, not ${name(expected)}.`,
    "",
    `Every read would answer about the wrong chain, so a contract that exists on`,
    `${name(expected)} reads back as no contract at all. Nothing is broken; the`,
    `endpoint is pointed somewhere else.`,
    "",
    `Check the ${label} URL — an endpoint issued for one network is not usable for`,
    "another, and Base and Base Sepolia are easy to mix up in a provider dashboard.",
  ].join("\n");
}
