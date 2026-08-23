/**
 * data.ts — the bundled sanctions dataset (CC-099).
 *
 * This is the always-on baseline control, not the whole screening programme. It exists
 * because the alternative — screening only via a hosted API — fails in exactly the way
 * the ticket argues against: it makes a third party's availability a precondition for
 * the platform's compliance control, and Chainalysis's API shape/coverage on Base was
 * still unconfirmed when this shipped (CC-099 Fix item 1). The dataset is small by
 * design: every entry must carry a verifiable provenance note, and a fabricated or
 * stale entry here blocks a real wallet, so the bar for adding one is a citation, not
 * a vibe.
 *
 * Updating it is a manual, reviewed act — the re-screening monitor
 * (scripts/audit/verify-sanctions.ts) is what detects a wallet that was clean at
 * registration and listed later. That ordering is deliberate: automation screens what
 * is already known, humans decide what joins the deny set.
 *
 * Provenance notes are required. The OFAC SDN list moves in both directions (Tornado
 * Cash addresses were designated in 2022 and *removed* in 2025 after Van Loon), so an
 * uncited entry is not just unverified — it is unverifiable six months later.
 */

export interface SanctionedAddressEntry {
  /** Lowercase 0x + 40 hex. The module normalises before lookup; entries must be pre-normalised. */
  address: string;
  /** Which list the designation comes from, e.g. "OFAC SDN". */
  list: string;
  /** Who/what is designated, enough to find the listing again. */
  reason: string;
  /** Where the designation can be checked, so this file's claims stay falsifiable. */
  source: string;
}

/**
 * Seed entries. Deliberately minimal — one entry, with provenance — rather than a bulk
 * paste nobody has verified line by line.
 *
 * DFAT note: Australia's consolidated list does carry digital-currency-address
 * identifiers, but no EVM address on it has been verified against this file's bar.
 * When one appears, it goes here with the same citation requirement — the module
 * supports DFAT entries without any code change, which is the point of the schema.
 */
export const SANCTIONED_ADDRESSES: readonly SanctionedAddressEntry[] = [
  {
    // The Ronin Bridge attacker. Designated April 2022 as a Lazarus Group identifier
    // and still on the SDN list as of 2026-08-23. Listed here both because it is a
    // genuine, stable designation and because it gives the local control a real test
    // vector that is not a placeholder.
    address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
    list: "OFAC SDN",
    reason: "Lazarus Group — Ronin Bridge attacker designation",
    source:
      "https://sanctionssearch.ofac.treas.gov/ (entity: LAZARUS GROUP; digital currency address identifier)",
  },
];

/** Lookup index built once at module load. Keyed by the normalised address. */
export const SANCTIONED_ADDRESS_INDEX: ReadonlyMap<string, SanctionedAddressEntry> =
  new Map(SANCTIONED_ADDRESSES.map((e) => [e.address, e]));
