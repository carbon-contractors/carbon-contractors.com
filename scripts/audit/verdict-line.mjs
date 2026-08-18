/**
 * verdict-line.mjs — turn a monitor's raw output into the one line that goes in the alert.
 *
 * Extracted from run-monitors.mjs so it can be tested. It could not be, previously, and its
 * fallback branch shipped a bug straight into the alerting path: see CRASH_NOISE below.
 */

/**
 * Markers every audit script uses to state its conclusion. TRANSIENT is for a monitor that
 * could not reach the chain — infrastructure, not an invariant violation, and worth saying
 * so in the alert because the two want completely different responses.
 */
const VERDICT = /^(CLEAN|VIOLATION|STRANDED|DEFICIT|PASS|FAIL|UNEXPECTED|MISCONFIGURED|TRANSIENT)\b/;

/**
 * Lines that carry no information when a monitor crashes.
 *
 * `Version: viem@2.55.10` is the last line of every uncaught viem error. The old fallback
 * returned `lines.at(-1)`, so on 2026-08-17 a failed RPC read produced a Discord alert whose
 * entire content was that version string — while the actual cause sat two lines above it.
 * Every RPC failure would have reported identically.
 */
const CRASH_NOISE = /^(Version: |at\s)/;

/** viem prints these as its structured detail, and they are the useful part. */
const DETAIL = /^(Status|URL|Details|Reason|Docs):/i;

/**
 * @param {string} out combined stdout+stderr from the monitor
 * @returns {string} a single line suitable for a chat notification
 */
export function verdictLine(out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);

  const idx = lines.findLastIndex((l) => VERDICT.test(l));

  if (idx === -1) {
    // No verdict marker at all: the monitor died before reaching its conclusion. Say that
    // explicitly rather than emitting a bare line the reader has to guess the status of.
    // Not anchored to line start: a script's own wrapper text usually precedes the class,
    // as in `block timestamp read failed: HttpRequestError: HTTP request failed.` The
    // capital is what keeps this from matching prose containing the word "error".
    const errClass = lines.find((l) => /\b[A-Z][\w.$]*(Error|Exception)\b/.test(l));
    const detail = lines.filter((l) => DETAIL.test(l)).slice(0, 2);
    const lastUseful = [...lines].reverse().find((l) => !CRASH_NOISE.test(l));

    const parts = ["CRASHED before reporting a verdict —"];
    if (errClass) parts.push(errClass);
    if (detail.length > 0) parts.push(...detail);
    else if (lastUseful && lastUseful !== errClass) parts.push(lastUseful);
    if (parts.length === 1) parts.push("(no output)");

    return parts.join(" ").slice(0, 400);
  }

  // `VIOLATION — 2 problem(s):` alone is useless in a notification, so the `·` bullets that
  // follow it are appended. An alert that makes you open the log to learn anything is worse.
  const detail = [];
  for (const l of lines.slice(idx + 1)) {
    if (!l.startsWith("·")) break;
    detail.push(l);
  }
  return [lines[idx], ...detail].join(" ").slice(0, 400);
}
