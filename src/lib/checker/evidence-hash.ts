/**
 * evidence-hash.ts — the evidenceHash preimage (CC-092, mirroring spec/hash.ts).
 *
 * `evidenceHash` has to be computed identically by the worker (commits it as the
 * `evidenceHash` argument to `submitWork`) and the platform (verifies a caller-supplied
 * bundle against that on-chain commitment before running the checker on it). Same
 * reasoning as `spec/hash.ts`: no canonicalisation step, the preimage is the exact
 * bytes the caller sent, and re-serialising would produce a hash the worker's own
 * on-chain commitment no longer matches.
 *
 * Deliberately stateless: this module never persists a bundle. CC-092's design notes
 * record why — `request_human_work`'s own tool description already tells every hiring
 * agent "the platform stores hashes only and holds none of the bytes" (CC-088), and
 * `checker/types.ts` treats extraction as happening "upstream and out of band." A
 * verdict request supplies the bundle fresh each time; nothing here writes it to a DB.
 */

import { keccak256, toHex } from "viem";
import { z } from "zod";
import type { EvidenceBundle } from "./types";

/** Bounds the hash input and the request body; not a security control. */
export const MAX_EVIDENCE_BYTES = 65536;
const MAX_ARTIFACTS = 200;

export class EvidenceBundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBundleValidationError";
  }
}

const EvidenceArtifactSchema = z
  .object({
    uri: z.string().min(1).max(2000),
    mimeType: z.string().max(200).optional(),
    exif: z
      .object({
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        dateTimeOriginal: z.string().max(64).optional(),
        cameraMake: z.string().max(200).optional(),
        cameraModel: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    c2paAiGenerated: z.boolean().optional(),
    phash: z.string().max(256).optional(),
  })
  .strict();

const EvidenceBundleSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    artifacts: z.array(EvidenceArtifactSchema).min(1).max(MAX_ARTIFACTS),
    submittedAt: z.iso.datetime().optional(),
  })
  .strict();

export interface ParsedEvidenceBundle {
  /** The verbatim string the caller sent. This, and only this, is the hash preimage. */
  preimage: string;
  /** `keccak256(toHex(preimage))` — compared against the on-chain `evidenceHash`. */
  hash: `0x${string}`;
  /** Validated, for the checker (CC-083). */
  bundle: EvidenceBundle;
}

/** Hash an already-validated preimage. Exported so tests can pin known vectors. */
export function hashEvidenceBundlePreimage(preimage: string): `0x${string}` {
  return keccak256(toHex(preimage));
}

/**
 * Parse, validate and hash an evidence bundle.
 *
 * @param raw The exact JSON string supplied by the caller.
 * @throws {EvidenceBundleValidationError} on anything malformed — never returns a
 *   partial result.
 */
export function parseAndHashEvidenceBundle(raw: string): ParsedEvidenceBundle {
  if (raw.length > MAX_EVIDENCE_BYTES) {
    throw new EvidenceBundleValidationError(
      `evidence bundle exceeds ${MAX_EVIDENCE_BYTES} characters`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EvidenceBundleValidationError("evidence bundle is not valid JSON");
  }

  const result = EvidenceBundleSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new EvidenceBundleValidationError(`evidence bundle is invalid — ${detail}`);
  }

  return {
    preimage: raw,
    hash: hashEvidenceBundlePreimage(raw),
    bundle: result.data,
  };
}
