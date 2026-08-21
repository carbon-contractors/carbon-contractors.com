/**
 * types.ts — inputs and outputs of the deterministic evidence checker (CC-083).
 *
 * The checker is specified by ADR-0001 D5: pure, deterministic, zero network calls.
 * A verdict containing anything non-reproducible (a wall clock, a fetched resource,
 * LLM inference) cannot be re-run, and a verdict that cannot be re-run is discretionary
 * authority wearing a technical costume. Everything in this module is shaped so that
 * the same inputs always produce a byte-identical Verdict.
 *
 * Evidence extraction — reading the artefact bytes off the agent's bucket and deriving
 * EXIF/C2PA/phash — happens upstream and out of band. The checker receives the
 * distilled attributes only, which is what keeps it offline and testable against the
 * canary fixture (`./canary/fixtures.ts`).
 */

/** One distilled artefact. Extracted upstream; never raw bytes here. */
export interface EvidenceArtifact {
  uri: string;
  mimeType?: string;
  exif?: {
    lat?: number;
    lon?: number;
    /** ISO-8601, or the raw EXIF "YYYY:MM:DD HH:MM:SS" form — see parseExifTimestamp. */
    dateTimeOriginal?: string;
    cameraMake?: string;
    cameraModel?: string;
  };
  /** True only when a C2PA manifest positively asserts generative-AI involvement. */
  c2paAiGenerated?: boolean;
  /** Perceptual hash, hex string. Width is whatever the extractor produced. */
  phash?: string;
}

/** The worker's submission, as submitted at `submitWork` and committed as `evidenceHash`. */
export interface EvidenceBundle {
  taskId: string;
  artifacts: EvidenceArtifact[];
  /**
   * Part of the hashed evidence, so it is the one timestamp a verdict may carry
   * without breaking re-runnability — see `Verdict.evaluatedAt`.
   */
  submittedAt?: string;
}

/** Chain-derived task context. Both timestamps are Unix seconds. */
export interface TaskContext {
  fundingBlockTimestamp: number;
  deadlineTimestamp?: number;
}

/** One criterion, one result. Absent criteria produce no CheckResult at all. */
export interface CheckResult {
  check: string;
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Verdict {
  passed: boolean;
  checks: CheckResult[];
  /** Digest of the pinned rules that produced this verdict — see ./hash.ts. */
  checkerHash: `0x${string}`;
  ruleVersion: number;
  /**
   * NOT a wall clock. A fresh timestamp would make every re-run differ and destroy
   * the byte-identical property, so the evaluation time of record is the bundle's
   * `submittedAt` (itself part of the hashed evidence). Empty when the bundle omits it.
   */
  evaluatedAt: string;
}
