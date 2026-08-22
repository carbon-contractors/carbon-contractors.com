/**
 * format.ts — render an acceptance spec for the worker (CC-084, ADR-0001 D3).
 *
 * The worker sees the spec before accepting a task, so what they read here IS the
 * deal: every row shown must correspond to something the checker (CC-083) actually
 * verifies. That is why the schema is `.strict()` — there are no custom or unknown
 * fields to fall through to a generic renderer, and this formatter's exhaustive
 * `switch` is the display-side half of that guarantee. A new schema field must add a
 * row here in the same change, or the worker is silently not shown a requirement.
 *
 * This file never serialises. The spec reaches it already parsed and validated
 * (`parseAndHashSpec`), and the hash preimage remains the agent's verbatim string —
 * nothing here feeds the hash.
 */

import { hasNoCriteria, type AcceptanceSpec } from "./schema";

/** The criteria half of a spec, for callers that already hold it separately. */
type Criteria = AcceptanceSpec["criteria"];

/** One human-readable line in the worker's view of a task's definition of done. */
export interface CriteriaRow {
  /** The criteria field (or sub-field) the row renders, e.g. `exif_gps_within_m`. */
  key: string;
  /** Short heading, e.g. "GPS location". */
  label: string;
  /** The concrete requirement, e.g. "-37.8136, 144.9631 within 100 m". */
  value: string;
  /** What the checker does with it — plain terms, no contract jargon. */
  description: string;
}

/** Rendered when a spec commits to nothing checkable — see `hasNoCriteria`. */
export const NO_CRITERIA_ROW: CriteriaRow = {
  key: "no_criteria",
  label: "No machine-checkable criteria",
  value: "None declared",
  // Not hedged, because it is load-bearing: with no criteria there is nothing a
  // verdict can fail against, so the task can only ever resolve to the worker
  // (ADR-0001). The worker should know that before accepting.
  description:
    "This task declares no requirements the platform can automatically verify, " +
    "so no evidence can be rejected on delivery and payment cannot be withheld " +
    "for quality.",
};

/**
 * The worker must read exactly the number the agent committed. `String(n)` does
 * that: the spec arrived as JSON, so `lat`/`threshold` have already round-tripped
 * through `JSON.parse` and back via the shortest round-trip algorithm — there is
 * no float noise left to trim, and no rounding of the agent's own number either.
 */
function num(n: number): string {
  return String(n);
}

/** Deterministic UTC rendering — never `toLocaleString`, whose output depends on the viewer's locale and timezone. */
function isoToUtc(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

function gpsRow(c: {
  lat: number;
  lon: number;
  radius_m: number;
}): CriteriaRow {
  const { lat, lon, radius_m } = c;
  return {
    key: "exif_gps_within_m",
    label: "GPS location",
    value: `${num(lat)}, ${num(lon)} — within ${num(radius_m)} m`,
    description:
      "Each artefact's EXIF GPS must place it within " +
      `${num(radius_m)} metres of ${num(lat)}, ${num(lon)}.`,
  };
}

/**
 * Format the criteria of a spec into display rows, in the schema's own field order.
 *
 * Returns `[NO_CRITERIA_ROW]` (not `[]`) when nothing is declared, so a caller
 * rendering an empty list has a bug rather than an honest "no criteria" display.
 */
export function formatCriteria(
  criteria: Criteria | null | undefined,
): CriteriaRow[] {
  if (!criteria || Object.keys(criteria).length === 0) {
    return [NO_CRITERIA_ROW];
  }

  const rows: CriteriaRow[] = [];

  if (criteria.min_artefacts !== undefined) {
    rows.push({
      key: "min_artefacts",
      label: "Minimum artefacts",
      value: `At least ${num(criteria.min_artefacts)}`,
      description:
        `The evidence must contain at least ${num(criteria.min_artefacts)} ` +
        "artefacts. Fewer fails the verdict.",
    });
  }

  if (criteria.exif_gps_within_m !== undefined) {
    rows.push(gpsRow(criteria.exif_gps_within_m));
  }

  if (criteria.captured_after !== undefined) {
    const isSentinel =
      criteria.captured_after === "task_funding_block_timestamp";
    rows.push({
      key: "captured_after",
      label: "Captured after",
      value: isSentinel
        ? "The task's funding block timestamp"
        : isoToUtc(criteria.captured_after),
      description:
        "Artefacts whose capture time is before this point fail the verdict. " +
        (isSentinel
          ? "The exact time is fixed when the task is funded on-chain."
          : ""),
    });
  }

  if (criteria.provenance !== undefined) {
    const p = criteria.provenance;
    if (p.require_camera_model !== undefined) {
      rows.push({
        key: "provenance.require_camera_model",
        label: "Camera model required",
        value: p.require_camera_model ? "Yes" : "No",
        description:
          "EXIF must record a camera model. " +
          (p.require_camera_model
            ? "Artefacts without one fail the verdict."
            : "Not required, but a missing model is still reported."),
      });
    }
    if (p.reject_c2pa_ai_generated !== undefined) {
      rows.push({
        key: "provenance.reject_c2pa_ai_generated",
        label: "AI-generated content",
        value: p.reject_c2pa_ai_generated ? "Rejected" : "Allowed",
        description:
          "C2PA provenance metadata is inspected for AI-generation signals. " +
          (p.reject_c2pa_ai_generated
            ? "Artefacts flagged as AI-generated fail the verdict."
            : "AI-generated artefacts are accepted."),
      });
    }
  }

  if (criteria.phash_max_similarity_to !== undefined) {
    const { source, threshold } = criteria.phash_max_similarity_to;
    rows.push({
      key: "phash_max_similarity_to",
      label: "Visual similarity cap",
      value: `No more than ${num(threshold)} similarity to ${source}`,
      description:
        "Each artefact is perceptually hashed and compared against the " +
        `existing ${source} set. Similarity above ${num(threshold)} — ` +
        "i.e. a re-upload of existing material — fails the verdict.",
    });
  }

  return rows;
}

/**
 * Format a whole spec for the worker's view of a task.
 *
 * Accepts `null`/`undefined` for tasks created before CC-084 or categories that
 * ship no spec at all; those render exactly like a spec with empty criteria,
 * because the consequence for the worker is the same one.
 */
export function formatSpecForDisplay(
  spec: AcceptanceSpec | null | undefined,
): CriteriaRow[] {
  if (!spec || hasNoCriteria(spec)) {
    return [NO_CRITERIA_ROW];
  }
  return formatCriteria(spec.criteria);
}
