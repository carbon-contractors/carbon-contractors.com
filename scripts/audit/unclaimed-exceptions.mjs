/**
 * unclaimed-exceptions.mjs — tasks verify-unclaimed knows are unclaimable, and why.
 * CC-079, CC-104.
 *
 * verify-unclaimed asserts that a task a worker CAN claim does not sit unclaimed. Its
 * premise is that a claim is possible. One class of task breaks that premise: a test task
 * whose throwaway worker key has been lost. `releaseAfterArbitration` / `releaseAfterReview`
 * are worker-only by design (ADR-0001 A1.2, ADR-0006 D3), so nothing — not the owner, the
 * agent or the platform — can ever claim it, and the monitor would page every hour forever
 * about money no human can move. That is the alert fatigue ADR-0003 warns about, arriving
 * from a task that was never a UX failure.
 *
 * So the exception is narrow, and loud rather than silent:
 *
 *  - keyed on escrow address AND task id, so a redeploy (new address) clears it by itself;
 *  - an acknowledged task is still printed, marked ACKNOWLEDGED with its reason, and still
 *    counted in the totals — it just stops deciding the exit code;
 *  - every entry carries `review_by`; past it the entry stops suppressing and the monitor
 *    goes red again, naming the lapsed entry (same pattern as scripts/audit-allowlist.json);
 *  - it is never for a real worker's task. The only legitimate entry is one whose key is
 *    provably gone, with the ticket that records how.
 *
 * Pure and dependency-free so it is unit-testable (scripts/audit/__tests__).
 */

export const KNOWN_ORPHANS = [
  {
    escrow: "0xc6aa99a8226b679C71945dd9545685896a91E4d3",
    taskId: "0x6192e0ded51c75bf7fe7de558c527e765638a99aecfd0d41799d2eb07d49885a",
    ticket: "CC-079",
    reason:
      "arbitration-hold test task. Its throwaway worker (0xCCF488ac…3A8F) held the only key able " +
      "to call releaseAfterArbitration, and that key lived in an untracked .escrow-lifecycle-state.json " +
      "that was lost in a machine reformat on 2026-10-13. 1 USDC of testnet funds, unrecoverable.",
    added: "2026-10-13",
    review_by: "2026-11-13",
  },
];

const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** An entry stops suppressing at the end of its review_by day (UTC). */
function isLapsed(entry, asOfSec) {
  const end = Date.parse(`${entry.review_by}T23:59:59Z`);
  return !Number.isFinite(end) || asOfSec * 1000 > end;
}

/**
 * Split rows (each carrying `taskId`) into those that still count and those acknowledged.
 *
 * @returns {{ live: object[], acknowledged: {row: object, entry: object}[], lapsed: object[] }}
 *   `lapsed` lists entries that matched a row but are past review_by — those rows stay live.
 */
export function splitAcknowledged(rows, escrow, asOfSec, entries = KNOWN_ORPHANS) {
  const live = [];
  const acknowledged = [];
  const lapsed = [];
  for (const row of rows) {
    const entry = entries.find((e) => eq(e.escrow, escrow) && eq(e.taskId, row.taskId));
    if (!entry) {
      live.push(row);
    } else if (isLapsed(entry, asOfSec)) {
      live.push(row);
      if (!lapsed.includes(entry)) lapsed.push(entry);
    } else {
      acknowledged.push({ row, entry });
    }
  }
  return { live, acknowledged, lapsed };
}
