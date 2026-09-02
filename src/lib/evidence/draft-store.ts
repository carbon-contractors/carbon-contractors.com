/**
 * draft-store.ts — persist evidence-form drafts in the worker's own browser
 * (NOR-328).
 *
 * Why client-side only: the platform deliberately does not retain evidence
 * bundles (CC-083 — the verdict request supplies the bundle fresh each time;
 * nothing writes it to a DB), and keeping it that way avoids a new
 * data-retention class under ADR-0002 D4 entirely. A lost draft costs a
 * re-fill; a stored one would be a privacy posture change. So the draft lives
 * in this browser, keyed per wallet, and claim-early/dispute arrive pre-filled
 * with what was submitted instead of demanding it a second time.
 */

import type { EvidenceArtifactDraft } from "@/lib/evidence/draft";

export interface StoredEvidenceDrafts {
  artifacts: EvidenceArtifactDraft[];
  /** keccak256 of the last bundle actually submitted for this task, when known. */
  submittedHash?: string;
}

const keyFor = (wallet: string) => `cc_evidence_drafts_${wallet.toLowerCase()}`;

/** Hard cap on the stored blob; drafts are dropped oldest-first past it. */
const MAX_BYTES = 512_000;

export function loadStoredDrafts(
  wallet: string,
): Record<string, StoredEvidenceDrafts> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(keyFor(wallet));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, StoredEvidenceDrafts>;
  } catch {
    // Corrupt JSON or storage disabled — an empty draft is the honest recovery.
    return {};
  }
}

export function saveStoredDrafts(
  wallet: string,
  drafts: Record<string, StoredEvidenceDrafts>,
): void {
  if (typeof window === "undefined") return;
  try {
    // Copy: the caller's object is state, not scratch space.
    const working: Record<string, StoredEvidenceDrafts> = { ...drafts };
    let json = JSON.stringify(working);
    for (const id of Object.keys(working)) {
      if (json.length <= MAX_BYTES) break;
      delete working[id];
      json = JSON.stringify(working);
    }
    if (json.length <= MAX_BYTES) {
      window.localStorage.setItem(keyFor(wallet), json);
    }
    // Still too big past the drop loop would be a bug elsewhere; skipping the
    // write is the safe failure — nothing above depends on persistence.
  } catch {
    // Private mode or disabled storage: session state still carries the draft.
  }
}
