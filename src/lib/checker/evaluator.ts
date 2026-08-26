/**
 * evaluator.ts — the deterministic evidence checker (CC-083, ADR-0001 D5).
 *
 * Pure function: no network, no clock, no randomness, no LLM. The same
 * (spec, bundle, context) produces a byte-identical Verdict on any machine, offline,
 * forever — that re-runnability is what makes a verdict falsifiable rather than
 * discretionary.
 *
 * Every check fails closed. Missing evidence for a required criterion is a failure,
 * never a skip: a verdict that quietly passes what it could not inspect is the
 * goalpost problem arriving through the back door.
 *
 * Not here, deliberately (ADR-0001 D5): "do these eight photos genuinely show the
 * vehicle's condition". Irreducibly subjective, routes to the D8 jury tier, and never
 * blocks a task from resolving.
 *
 * Multi-version dispatch (ADR-0001 Amendment 2 A2.2): specs are never migrated in
 * flight — a task resolves under the schema it was created with, permanently — so
 * dispatch on `schema_version` rather than assuming the current shape. One version
 * today; the shape is the point, mirroring `SCHEMAS_BY_VERSION` in spec/schema.ts.
 * The canary set keeps one case per supported version so a dropped version fails the
 * fixture instead of failing a real task.
 */

import type { AcceptanceSpec } from "@/lib/spec/schema";
import { haversineDistanceM } from "./haversine";
import { getCheckerHash, CHECKER_RULE_VERSION } from "./hash";
import type { CheckResult, EvidenceBundle, EvidenceArtifact, TaskContext, Verdict } from "./types";

export function evaluateEvidence(
  spec: AcceptanceSpec,
  bundle: EvidenceBundle,
  context: TaskContext,
): Verdict {
  const evaluate = EVALUATORS[spec.schema_version];
  if (!evaluate) {
    // A validated AcceptanceSpec can only carry a version some schema accepted, so
    // this fires when the checker lags the intake schema — exactly the case A2.2 says
    // must be loud rather than mis-evaluated.
    throw new Error(
      `checker cannot evaluate spec schema_version ${spec.schema_version} (known: ${Object.keys(EVALUATORS).join(", ")})`,
    );
  }

  const checks = evaluate(spec, bundle, context);
  return {
    passed: checks.every((c) => c.passed),
    checks,
    checkerHash: getCheckerHash(),
    ruleVersion: CHECKER_RULE_VERSION,
    // Wall-clock-free by design — see Verdict.evaluatedAt.
    evaluatedAt: bundle.submittedAt ?? "",
  };
}

// ── shared helpers ───────────────────────────────────────────────────────────

/**
 * Accepts ISO-8601 (`2026-08-20T04:12:09Z`, `Date.parse`-able) and the raw EXIF
 * `DateTimeOriginal` form ("2026:08:20 04:12:09"), which real cameras still emit with
 * colons in the date. Returns Unix seconds, or NaN for anything unparseable.
 *
 * Offset-less timestamps are read as UTC. `Date.parse` would read them as the host's
 * local timezone instead, which means the same verdict would differ between machines —
 * exactly what CC-083's byte-identical re-run forbids. (The EXIF spec makes
 * DateTimeOriginal local time with no offset, so the worker-side extractor is
 * responsible for converting to UTC before this reaches the checker.)
 */
export function parseExifTimestamp(value: string): number {
  const trimmed = value.trim();
  let iso = /^(\d{4}):(\d{2}):(\d{2})/.test(trimmed)
    ? `${trimmed.slice(0, 4)}-${trimmed.slice(5, 7)}-${trimmed.slice(8).replace(" ", "T")}`
    : trimmed;
  // Append Z when there is no offset — a trailing Z, +hh:mm or -hh:mm.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000);
}

/** Normalises a hex string (`0x` optional) to lowercase bare hex, or null if not hex. */
function normalizeHex(value: string): string | null {
  const bare = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]+$/.test(bare) ? bare : null;
}

/** Hamming distance between two equal-width bare-hex bitstrings, or null if unusable. */
function hammingHex(a: string, b: string): number | null {
  if (a.length !== b.length) return null;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    // Hex digit XOR, then popcount of the 4 bits.
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/**
 * Highest similarity between one artefact hash and any reference, in 0..1.
 *
 * Returns null when any reference is uncomparable (a differing width), rather than
 * scoring against the subset that happens to line up — a partial comparison would
 * report a low similarity for an artefact that was never fully checked, which is the
 * "could not check" case reading as a pass.
 */
function maxSimilarity(artifact: string, references: string[]): number | null {
  let highest: number | null = null;
  for (const reference of references) {
    const distance = hammingHex(reference, artifact);
    if (distance === null) return null;
    const similarity = 1 - distance / (reference.length * 4);
    if (highest === null || similarity > highest) highest = similarity;
  }
  return highest;
}

function hasCameraModel(artifact: EvidenceArtifact): boolean {
  const { cameraMake = "", cameraModel = "" } = artifact.exif ?? {};
  return cameraMake.trim() !== "" || cameraModel.trim() !== "";
}

/** Per-artifact breakdown: distances in the order the artefacts were submitted. */
function gpsDistances(
  artifacts: EvidenceArtifact[],
  lat: number,
  lon: number,
): Array<{ uri: string; distance_m: number | null }> {
  return artifacts.map((a) => {
    const { lat: aLat, lon: aLon } = a.exif ?? {};
    const ok = typeof aLat === "number" && typeof aLon === "number";
    return {
      uri: a.uri,
      distance_m: ok ? haversineDistanceM(aLat!, aLon!, lat, lon) : null,
    };
  });
}

// ── v1 ───────────────────────────────────────────────────────────────────────

function evaluateV1(
  spec: Extract<AcceptanceSpec, { schema_version: 1 }>,
  bundle: EvidenceBundle,
  context: TaskContext,
): CheckResult[] {
  const c = spec.criteria;
  const checks: CheckResult[] = [];

  if (c.min_artefacts !== undefined) {
    checks.push({
      check: "min_artefacts",
      passed: bundle.artifacts.length >= c.min_artefacts,
      reason:
        bundle.artifacts.length >= c.min_artefacts
          ? undefined
          : `${bundle.artifacts.length} artefact(s) submitted, ${c.min_artefacts} required`,
      details: { submitted: bundle.artifacts.length, required: c.min_artefacts },
    });
  }

  if (c.exif_gps_within_m !== undefined) {
    const { lat, lon, radius_m } = c.exif_gps_within_m;
    const results = gpsDistances(bundle.artifacts, lat, lon);
    const missing = results.filter((r) => r.distance_m === null).map((r) => r.uri);
    const outside = results.filter(
      (r) => r.distance_m !== null && r.distance_m > radius_m,
    );
    checks.push({
      check: "exif_gps_within_m",
      passed: missing.length === 0 && outside.length === 0,
      reason:
        missing.length > 0
          ? `${missing.length} artefact(s) have no EXIF GPS coordinates: ${missing.join(", ")}`
          : outside.length > 0
            ? `${outside.length} artefact(s) beyond the ${radius_m} m radius`
            : undefined,
      details: { radius_m, target: { lat, lon }, results },
    });
  }

  if (c.captured_after !== undefined) {
    const thresholdTs =
      c.captured_after === "task_funding_block_timestamp"
        ? context.fundingBlockTimestamp
        : parseExifTimestamp(c.captured_after);
    const results = bundle.artifacts.map((a) => {
      const raw = a.exif?.dateTimeOriginal;
      const capturedTs = raw !== undefined ? parseExifTimestamp(raw) : NaN;
      return {
        uri: a.uri,
        captured_ts: Number.isNaN(capturedTs) ? null : capturedTs,
        // Missing/unparseable captures sort as "before the threshold" — fail closed.
        after: !Number.isNaN(capturedTs) && capturedTs >= thresholdTs,
      };
    });
    const failing = results.filter((r) => !r.after).map((r) => r.uri);
    checks.push({
      check: "captured_after",
      passed: failing.length === 0,
      reason:
        failing.length === 0
          ? undefined
          : `${failing.length} artefact(s) missing a capture timestamp or captured before the threshold: ${failing.join(", ")}`,
      details: { threshold_ts: thresholdTs, results },
    });
  }

  if (c.provenance?.require_camera_model) {
    const failing = bundle.artifacts.filter((a) => !hasCameraModel(a)).map((a) => a.uri);
    checks.push({
      check: "provenance.require_camera_model",
      passed: failing.length === 0,
      reason:
        failing.length === 0
          ? undefined
          : `no camera make or model on: ${failing.join(", ")}`,
    });
  }

  if (c.provenance?.reject_c2pa_ai_generated) {
    // Absence of a C2PA manifest is not an assertion of AI generation — real photos
    // without manifests are the norm. Only a positive assertion fails.
    const flagged = bundle.artifacts
      .filter((a) => a.c2paAiGenerated === true)
      .map((a) => a.uri);
    checks.push({
      check: "provenance.reject_c2pa_ai_generated",
      passed: flagged.length === 0,
      reason:
        flagged.length === 0 ? undefined : `C2PA asserts AI generation on: ${flagged.join(", ")}`,
    });
  }

  if (c.phash_max_similarity_to !== undefined) {
    const { source, threshold } = c.phash_max_similarity_to;

    // A CAP. An artefact fails by being too similar to a reference — a re-upload of
    // material that already existed — not by failing to match one.
    //
    // This was implemented backwards (`similarity >= threshold`, a floor) between
    // 2026-08-21 and 2026-08-26, which inverted the control: a fraudulent re-upload
    // passed at similarity 1.0 and an honest new photograph failed. The criterion is
    // named `max_similarity_to`, CC-084 scopes it against the agent's existing
    // listing photos, and spec/format.ts renders it to the worker as a cap — all
    // three agreed with each other and disagreed with the checker. Nothing caught it
    // because it was the one criterion with no failing canary case; the completeness
    // block in canary.test.ts now makes that combination impossible.
    const references = source.map(normalizeHex);
    const badReferenceIndex = references.findIndex((r) => r === null);
    const validReferences = badReferenceIndex === -1 ? (references as string[]) : null;

    const results = bundle.artifacts.map((a) => {
      const artifact = a.phash !== undefined ? normalizeHex(a.phash) : null;
      const similarity =
        validReferences !== null && artifact !== null
          ? maxSimilarity(artifact, validReferences)
          : null;
      return {
        uri: a.uri,
        similarity,
        // Fail closed. A hash that is missing, non-hex, or a different width from the
        // references cannot be shown NOT to be a re-upload, and "could not check" must
        // never read as "passed".
        withinCap: similarity !== null && similarity <= threshold,
      };
    });

    const uncomparable = results.filter((r) => r.similarity === null).map((r) => r.uri);
    const tooSimilar = results
      .filter((r) => r.similarity !== null && r.similarity > threshold)
      .map((r) => r.uri);
    const failing = results.filter((r) => !r.withinCap);

    checks.push({
      check: "phash_max_similarity_to",
      passed: failing.length === 0,
      reason:
        failing.length === 0
          ? undefined
          : validReferences === null
            ? `reference phash in the spec is not a valid hex string: ${source[badReferenceIndex]}`
            : tooSimilar.length > 0
              ? `${tooSimilar.length} artefact(s) exceed the ${threshold} similarity cap — ` +
                `already-existing material: ${tooSimilar.join(", ")}`
              : `${uncomparable.length} artefact(s) have no comparable perceptual hash: ` +
                uncomparable.join(", "),
      details: { threshold, reference_count: source.length, results },
    });
  }

  return checks;
}

const EVALUATORS: Record<number, (spec: AcceptanceSpec, bundle: EvidenceBundle, context: TaskContext) => CheckResult[]> = {
  1: evaluateV1,
};
