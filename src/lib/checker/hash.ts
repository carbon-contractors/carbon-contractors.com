/**
 * hash.ts — the checkerHash (CC-083, ADR-0001 D5).
 *
 * A verdict is only falsifiable if anyone can re-run it, and it can only be re-run if
 * the rules that produced it are pinned. `checkerHash` is the digest of that pinning:
 * it covers which checks exist, how each is computed, and which spec schema versions
 * the checker can evaluate. It doubles as `ruleVersion` in the verdict.
 *
 * `keccak256(toHex(…))` matches the repo idiom — see `hashSpecPreimage` in
 * `src/lib/spec/hash.ts` and `toTaskId` in `src/lib/contracts/escrow.ts`.
 *
 * Changing any rule below is a new CHECKER_RULE_VERSION, never an edit in place:
 * a verdict pinned to the old hash must still re-run identically forever.
 */

import { keccak256, toHex } from "viem";
import { SUPPORTED_SPEC_VERSIONS } from "@/lib/spec/schema";

export const CHECKER_RULE_VERSION = 1;

/**
 * Everything a re-run depends on, as a literal. JSON key order is insertion order, so
 * this exact source text IS the canonical serialisation — reviewed, not derived. No
 * timestamps, no versions read from package.json at runtime (a `npm update` would
 * silently change every verdict's hash).
 */
const RULE_METADATA_V1 = {
  rule_version: CHECKER_RULE_VERSION,
  spec_versions: [...SUPPORTED_SPEC_VERSIONS],
  checks: [
    "min_artefacts",
    "exif_gps_within_m",
    "captured_after",
    "provenance.require_camera_model",
    "provenance.reject_c2pa_ai_generated",
    "phash_max_similarity_to",
  ],
  haversine_earth_radius_m: 6371000,
  phash: {
    encoding: "hex",
    similarity: "1 - popcount(xor) / bit_width",
    comparison: "every artifact must reach the threshold similarity to the reference",
  },
};

/** Hash an already-built preimage. Exported so tests can pin known vectors. */
export function hashRuleMetadata(metadata: unknown): `0x${string}` {
  return keccak256(toHex(JSON.stringify(metadata)));
}

const HASHES_BY_VERSION: Record<number, `0x${string}`> = {
  [CHECKER_RULE_VERSION]: hashRuleMetadata(RULE_METADATA_V1),
};

/**
 * The digest of the pinned rules for a rule version.
 *
 * @throws on an unknown version. A verdict pinned to a checkerHash this build cannot
 *   reproduce is precisely the failure D5 exists to prevent — it must be loud, not a
 *   silently different hash.
 */
export function getCheckerHash(version: number = CHECKER_RULE_VERSION): `0x${string}` {
  const hash = HASHES_BY_VERSION[version];
  if (!hash) {
    throw new Error(
      `unknown checker rule version ${version} (known: ${Object.keys(HASHES_BY_VERSION).join(", ")})`,
    );
  }
  return hash;
}
