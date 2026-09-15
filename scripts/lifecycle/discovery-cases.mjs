/**
 * discovery-cases.mjs — the CC-032 discovery-stage case registry.
 *
 * Pure data + pure helpers, no side effects. Mirrors cases.mjs (CC-077): one
 * CLI flag per case, the systematic pass is the default. Discovery cases are
 * all off-chain and cost nothing to run — there is no fund-flow/guard split
 * here because there is no money anywhere in this stage.
 *
 * What CC-032 owns after the 2026-08-11 split (from the ticket's own text):
 *   register → discover via MCP (search_whitepages, get_contractor) → the
 *   worker is findable with correct categories, rate and availability.
 *
 * The systematic pass then becomes four independent Findability proofs, each
 * a full register → read-back cycle through a different surface, plus the
 * honest negative control: the same reads against a wallet that was never
 * registered must 404 / CONTRACTOR_NOT_FOUND — proving the reads answer from
 * the registry, not from a cache that would say yes to anything.
 */

/** The case registry. `null` flag = default (no case flag needed). */
export const DISCOVERY_CASES = {
  systematic: {
    flag: null,
    title: "Systematic discovery pass — register once, find through every surface",
    summary:
      "A fresh throwaway wallet registers (2 categories, distinct rate) → search_whitepages returns it in its categories → get_contractor finds it by wallet AND by UUID → /api/profile agrees → cross-surface consistency asserted → row left 'offline' (visible, unbookable).",
    kind: "systematic",
    requiresRegisteredRow: false,
    assertClean:
      "Every read surface returns the same categories, rate and availability for the new wallet; the negative control (never-registered wallet) 404s everywhere; the row is left in the state the last step set.",
  },
  alreadyRegistered: {
    flag: "--case-already-registered",
    title: "Re-registering an existing wallet upserts, not duplicates",
    summary:
      "Register the same wallet twice with different categories/rate. The whitepages row must update in place (onConflict wallet) and get_contractor must return the NEW values — a duplicate row would poison every search result.",
    kind: "upsert",
    requiresRegisteredRow: false,
    assertClean:
      "get_contractor returns exactly one row for the wallet, carrying the second registration's categories and rate; search_whitepages for the dropped category no longer returns it (results from the registry, not a cache).",
  },
  profileUpdate: {
    flag: "--case-profile-update",
    title: "PATCH /api/profile changes availability/rate/categories and reads agree",
    summary:
      "Register, then PATCH the profile to a new availability/rate/categories via a fresh signed profile-update message. Every read surface must return the updated values without re-registration.",
    kind: "update",
    requiresRegisteredRow: false,
    assertClean:
      "All read surfaces return the PATCHed values; the signed payload's action/wallet/freshness binding is what authorized the change.",
  },
};

/** flag string → case def (with its caseKey attached). */
export const DISCOVERY_CASES_BY_FLAG = Object.fromEntries(
  Object.entries(DISCOVERY_CASES)
    .filter(([, c]) => c.flag !== null)
    .map(([key, c]) => [c.flag, { ...c, caseKey: key }]),
);

export const DISCOVERY_CASE_FLAG_LIST = Object.keys(DISCOVERY_CASES_BY_FLAG);

/**
 * Which case a parsed argv selected. `systematic` when no case flag was given.
 * @throws {Error} if more than one case flag was passed (same rule as CC-077:
 *   each case asserts its own clean outcome and needs its own evidence trail).
 */
export function selectDiscoveryCase(caseKeys) {
  if (caseKeys.length > 1) {
    throw new Error(
      `Only one case flag per run — got ${caseKeys.length} (${caseKeys.join(", ")}). Each case asserts its own clean outcome and needs its own evidence trail.`,
    );
  }
  const caseKey = caseKeys[0] ?? "systematic";
  return { caseKey, caseDef: DISCOVERY_CASES[caseKey] };
}
