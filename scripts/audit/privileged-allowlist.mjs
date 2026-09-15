/**
 * privileged-allowlist.mjs — the committed allowlist of authorised privileged events
 * on the escrow, plus the pure matcher. CC-040.
 *
 * Extracted from verify-privileged-events.mjs so the match logic is unit-testable —
 * the first version of it shipped a field-name bug (allowlist `from`/`to` vs decoded
 * `previousOwner`/`newOwner`) that live testing caught and nothing else would have.
 * The monitors are the thing that tells us the money path is intact; leaving their
 * logic as the only untested code was the wrong trade (same reasoning as the
 * alert-classify extraction, CC-104).
 *
 * A redeploy (new escrow address) means a new allowlist: the new contract's history
 * starts empty, so the file is replaced wholesale and ESCROW_DEPLOY_BLOCK re-derived
 * (scripts/audit/find-deploy-block.mjs, CC-070).
 *
 * Verified against Base Sepolia 2026-09-16 for escrow 0xc6aa99a8226b679C71945dd9545685896a91E4d3
 * (the CC-082 v2 redeploy of 2026-09-01, block 46227900):
 *   block 46227900  OwnershipTransferred(0x0…0 → 0x7863A5c4…B91b)       tx 0xaa2746e2… (constructor: deployer becomes owner)
 *   block 46227900  VerdictSignerUpdated(0xa893…3e4b, true)             tx 0xaa2746e2… (constructor: signer accepted)
 *   block 46228351  OwnershipTransferred(0x7863A5c4…B91b → 0xa893…3e4b) tx 0xb5da85ab… (CC-059 handover to the HSM key)
 */

export const DEFAULT_ALLOWLIST = [
  {
    kind: "OwnershipTransferred",
    block: 46227900,
    tx: "0xaa2746e2d6f6d331bef906c9926133d6cd297c3a99c9bc5b58646db4da9a8ed4",
    previousOwner: "0x0000000000000000000000000000000000000000",
    newOwner: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
  },
  {
    kind: "VerdictSignerUpdated",
    block: 46227900,
    tx: "0xaa2746e2d6f6d331bef906c9926133d6cd297c3a99c9bc5b58646db4da9a8ed4",
    signer: "0xa8931097540e69B474013D294d0bA6A2cC853e4b",
    accepted: true,
  },
  {
    kind: "OwnershipTransferred",
    block: 46228351,
    tx: "0xb5da85ab0c22975262f7b9c0f9623e1502046759457d6074835743c6d47982f8",
    previousOwner: "0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b",
    newOwner: "0xa8931097540e69B474013D294d0bA6A2cC853e4b",
  },
];

/**
 * Does one on-chain event match one allowlist entry exactly?
 *
 * Exact means: kind, tx, block, and every decoded arg. Field names are the DECODED
 * names (previousOwner/newOwner/signer/accepted) — not prose labels — because the
 * matcher iterates the event's own arg keys and looks each up in the entry. An entry
 * using a synonym key silently matches nothing, which is how the first draft of this
 * table reported its own allowlisted events as breaches.
 *
 * @param {{kind: string, tx: string, block: number, args: Record<string, unknown>}} event
 * @param {object} entry
 */
export function matchEvent(event, entry) {
  if (entry.kind !== event.kind) return false;
  if (String(entry.tx).toLowerCase() !== String(event.tx).toLowerCase()) return false;
  if (Number(entry.block) !== Number(event.block)) return false;
  return Object.entries(event.args).every(([k, v]) => {
    const expected = entry[k];
    if (expected === undefined) return false; // entry missing a decoded field: no match
    if (typeof v === "boolean") return expected === v;
    if (typeof v === "bigint") return BigInt(expected) === v;
    return String(expected).toLowerCase() === String(v).toLowerCase();
  });
}

/** True when the event is authorised by at least one allowlist entry. */
export function isAuthorised(event, allowlist = DEFAULT_ALLOWLIST) {
  return allowlist.some((en) => matchEvent(event, en));
}
