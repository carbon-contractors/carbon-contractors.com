/**
 * schema.ts — machine-checkable acceptance criteria (CC-084, ADR-0001 D3).
 *
 * The spec is the definition of done. It is committed on-chain as `specHash` at
 * `createTask` and echoed by the worker as `specVersionAck` at `submitWork`, so once
 * a task is funded neither party can move it.
 *
 * `schema_version` lives INSIDE the hashed preimage, deliberately — ADR-0001
 * Amendment 2 A2.2. A task resolves under the schema it was created with,
 * permanently; there is no in-flight migration and no mechanism to invalidate one.
 * Deprecating a version means refusing it at intake, never rewriting existing tasks.
 */

import { z } from "zod";

/**
 * Versions this build accepts for NEW tasks.
 *
 * Retiring a version here does not orphan tasks that already committed to it — the
 * checker (CC-083) must keep evaluating every version that still has tasks
 * outstanding, which ADR-0001 D5's re-runnability requirement demands anyway.
 */
export const SUPPORTED_SPEC_VERSIONS = [1] as const;

/** Cap on the preimage. Bounds the DB write and the hash input; not a security control. */
export const MAX_SPEC_BYTES = 8192;

// ── v1 ───────────────────────────────────────────────────────────────────────

const GpsCriterion = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    radius_m: z.number().positive().max(100_000),
  })
  .strict();

const ProvenanceCriterion = z
  .object({
    require_camera_model: z.boolean().optional(),
    reject_c2pa_ai_generated: z.boolean().optional(),
  })
  .strict();

/**
 * A similarity **cap**, not a floor: an artefact fails when it is too close to
 * something that already existed. The scoped case (CC-084) is the hiring agent's own
 * listing photos — "do not hand me back my own pictures as proof of work".
 *
 * `source` carries the reference hashes themselves rather than a name for a set. The
 * checker is offline and deterministic by ADR-0001 D5, so it cannot resolve a label
 * like `"listing_images"` into anything, and a criterion the checker cannot evaluate
 * is one the worker is shown and nothing enforces. Carrying the hashes inline also
 * puts them inside the hashed preimage, so the reference set cannot move after
 * funding — the same goalpost property `specHash` exists to give the criteria.
 *
 * Hashes, never images: a perceptual hash is a fingerprint, so the platform stores a
 * fingerprint of the agent's own material and never the material (ADR-0002 D3).
 */
const PhashCriterion = z
  .object({
    /** Reference perceptual hashes, hex, `0x` optional. All must share a width. */
    source: z.array(z.string().min(1).max(200)).min(1).max(64),
    threshold: z.number().min(0).max(1),
  })
  .strict();

/**
 * Every field optional: deterministic checkability varies sharply by category
 * (ADR-0001's "category applicability" consequence). A photo errand checks well;
 * "review this PR" barely checks at all.
 *
 * `.strict()` throughout is load-bearing rather than tidiness. An unrecognised key
 * would be shown to the worker as though it were a requirement and then silently
 * ignored by the checker — the goalpost problem the spec exists to prevent, arriving
 * through the back door. If it is in the spec, it must be checkable.
 */
const CriteriaV1 = z
  .object({
    min_artefacts: z.number().int().positive().max(1000).optional(),
    exif_gps_within_m: GpsCriterion.optional(),
    captured_after: z
      .union([z.literal("task_funding_block_timestamp"), z.iso.datetime()])
      .optional(),
    provenance: ProvenanceCriterion.optional(),
    phash_max_similarity_to: PhashCriterion.optional(),
  })
  .strict();

/**
 * Where evidence is written. The hiring agent nominates it — they commissioned the
 * work and receive it, so they are the controller in fact (ADR-0002 D3). The platform
 * never holds the bytes.
 *
 * Optional until CC-083's evidence path exists.
 */
const EvidenceBucketV1 = z
  .object({
    provider: z.enum(["s3", "gcs", "https"]),
    target: z.string().min(1).max(500),
  })
  .strict();

export const AcceptanceSpecV1 = z
  .object({
    schema_version: z.literal(1),
    criteria: CriteriaV1,
    evidence_bucket: EvidenceBucketV1.optional(),
  })
  .strict();

export type AcceptanceSpecV1 = z.infer<typeof AcceptanceSpecV1>;

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Union of every supported version. One member today; the shape is the point. */
export type AcceptanceSpec = AcceptanceSpecV1;

const SCHEMAS_BY_VERSION: Record<number, z.ZodType<AcceptanceSpec>> = {
  1: AcceptanceSpecV1,
};

export function schemaForVersion(
  version: number,
): z.ZodType<AcceptanceSpec> | null {
  return SCHEMAS_BY_VERSION[version] ?? null;
}

/**
 * True when the spec commits to nothing machine-checkable.
 *
 * Worth surfacing rather than swallowing: ADR-0001 records that a task with no
 * checkable criteria ALWAYS resolves to the worker, because a dispute requires a
 * signed failing verdict and there is nothing to fail against. That may be a
 * deliberate choice for an uncheckable category — it should never be an accident.
 */
export function hasNoCriteria(spec: AcceptanceSpec): boolean {
  return Object.keys(spec.criteria).length === 0;
}
