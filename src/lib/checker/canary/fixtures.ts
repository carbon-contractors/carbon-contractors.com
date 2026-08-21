/**
 * fixtures.ts — the canary evidence set (CC-083, ADR-0001 D5 / ADR-0003 D2).
 *
 * A committed, versioned set of evidence with known-correct verdicts. Two jobs:
 *
 * 1. The re-runnability fixture — the canary test drives these through the real
 *    pipeline (`parseAndHashSpec` → `evaluateEvidence`) and asserts the expected
 *    verdicts, so a rule change that alters any outcome fails here, not on a real task.
 * 2. The input to the `verify-checker` monitor (CC-085). "The checker is running" is
 *    not the property worth holding; "the checker still returns the right answers" is.
 *    A checker that is up and wrong is worse than one that is down, because down
 *    eventually fails loudly and wrong never does.
 *
 * Each failing case fails exactly ONE check — answering CC-083's open question "does
 * the set include evidence designed to fail each individual check independently" with
 * yes, because a case that fails three checks at once masks a regression in two of them.
 *
 * One case per supported spec schema version at minimum (ADR-0001 A2.2): retiring a
 * version must fail the fixture before it fails a live task.
 */

import type { EvidenceArtifact, EvidenceBundle, TaskContext } from "../types";

export interface CanaryCase {
  name: string;
  description: string;
  /** Raw spec preimage — parsed through `parseAndHashSpec`, the real pipeline, not inlined as an object. */
  specPreimage: string;
  bundle: EvidenceBundle;
  context: TaskContext;
  expectedPassed: boolean;
  /** The exact set of checks expected to fail. Empty for the passing case. */
  expectedFailedChecks: string[];
}

/**
 * The scenario behind every case: the ADR-0001 car-photo task — photograph the vehicle
 * at a Melbourne location, after funding, with camera provenance intact.
 *
 * Funding block: 2026-08-16T00:00:00Z = 1786838400.
 */
const CONTEXT: TaskContext = { fundingBlockTimestamp: 1786838400 };

/** Full v1 spec. Same criteria for every case, so each failure is isolated to the evidence. */
const FULL_V1_SPEC =
  '{"schema_version":1,"criteria":{' +
  '"min_artefacts":2,' +
  '"exif_gps_within_m":{"lat":-37.8136,"lon":144.9631,"radius_m":100},' +
  '"captured_after":"task_funding_block_timestamp",' +
  '"provenance":{"require_camera_model":true,"reject_c2pa_ai_generated":true},' +
  '"phash_max_similarity_to":{"source":"ff00ff00ff00ff00","threshold":0.9}' +
  "}}";

/**
 * -37.8131 is ~56 m north of the target — inside the 100 m radius.
 * "2026-08-17T05:30:00Z" is a day after funding.
 * The phash differs from the reference by one bit of 64 → similarity 0.984 ≥ 0.9.
 */
function goodArtifact(index: number): EvidenceArtifact {
  return {
    uri: `https://agent-bucket.example/canary/artifact-${index}.jpg`,
    mimeType: "image/jpeg",
    exif: {
      lat: -37.8131,
      lon: 144.9631,
      dateTimeOriginal: "2026-08-17T05:30:00Z",
      cameraMake: "Apple",
      cameraModel: "iPhone 15",
    },
    c2paAiGenerated: false,
    phash: "ff00ff00ff00ff01",
  };
}

function goodBundle(): EvidenceBundle {
  return {
    taskId: "canary-task",
    artifacts: [goodArtifact(1), goodArtifact(2)],
    submittedAt: "2026-08-17T06:00:00Z",
  };
}

// ── the cases ────────────────────────────────────────────────────────────────

/** Every check passes. Also the schema_version 1 coverage case (A2.2). */
export const CANARY_PASS_ALL: CanaryCase = {
  name: "pass-all",
  description: "clean submission satisfies every criterion",
  specPreimage: FULL_V1_SPEC,
  bundle: goodBundle(),
  context: CONTEXT,
  expectedPassed: true,
  expectedFailedChecks: [],
};

export const CANARY_FAIL_MIN_ARTEFACTS: CanaryCase = {
  name: "fail-min-artefacts",
  description: "two artefacts against a minimum of three — count alone fails",
  specPreimage: FULL_V1_SPEC.replace('"min_artefacts":2', '"min_artefacts":3'),
  bundle: goodBundle(),
  context: CONTEXT,
  expectedPassed: false,
  expectedFailedChecks: ["min_artefacts"],
};

export const CANARY_FAIL_GPS_RADIUS: CanaryCase = {
  name: "fail-gps-radius",
  description: "one artefact photographed ~1.1 km from the target",
  specPreimage: FULL_V1_SPEC,
  bundle: (() => {
    const bundle = goodBundle();
    // 0.01° of latitude ≈ 1.1 km, well outside the 100 m radius.
    bundle.artifacts[1] = { ...bundle.artifacts[1], exif: { ...bundle.artifacts[1].exif!, lat: -37.8031 } };
    return bundle;
  })(),
  context: CONTEXT,
  expectedPassed: false,
  expectedFailedChecks: ["exif_gps_within_m"],
};

export const CANARY_FAIL_CAPTURED_BEFORE_FUNDING: CanaryCase = {
  name: "fail-captured-before-funding",
  description: "one artefact captured a day before the funding block — the ADR-0001 fraudulent case",
  specPreimage: FULL_V1_SPEC,
  bundle: (() => {
    const bundle = goodBundle();
    bundle.artifacts[1] = {
      ...bundle.artifacts[1],
      exif: { ...bundle.artifacts[1].exif!, dateTimeOriginal: "2026-08-15T05:30:00Z" },
    };
    return bundle;
  })(),
  context: CONTEXT,
  expectedPassed: false,
  expectedFailedChecks: ["captured_after"],
};

export const CANARY_FAIL_CAMERA_MODEL: CanaryCase = {
  name: "fail-camera-model",
  description: "one artefact carries neither camera make nor model",
  specPreimage: FULL_V1_SPEC,
  bundle: (() => {
    const bundle = goodBundle();
    const { lat, lon, dateTimeOriginal } = bundle.artifacts[1].exif!;
    bundle.artifacts[1] = {
      ...bundle.artifacts[1],
      exif: { lat, lon, dateTimeOriginal, cameraMake: "", cameraModel: "" },
    };
    return bundle;
  })(),
  context: CONTEXT,
  expectedPassed: false,
  expectedFailedChecks: ["provenance.require_camera_model"],
};

export const CANARY_FAIL_C2PA_AI: CanaryCase = {
  name: "fail-c2pa-ai-generated",
  description: "one artefact's C2PA manifest positively asserts generative-AI involvement",
  specPreimage: FULL_V1_SPEC,
  bundle: (() => {
    const bundle = goodBundle();
    bundle.artifacts[1] = { ...bundle.artifacts[1], c2paAiGenerated: true };
    return bundle;
  })(),
  context: CONTEXT,
  expectedPassed: false,
  expectedFailedChecks: ["provenance.reject_c2pa_ai_generated"],
};

/** The full set, in stable order. verify-checker (CC-085) iterates this. */
export const CANARY_CASES: readonly CanaryCase[] = [
  CANARY_PASS_ALL,
  CANARY_FAIL_MIN_ARTEFACTS,
  CANARY_FAIL_GPS_RADIUS,
  CANARY_FAIL_CAPTURED_BEFORE_FUNDING,
  CANARY_FAIL_CAMERA_MODEL,
  CANARY_FAIL_C2PA_AI,
];
