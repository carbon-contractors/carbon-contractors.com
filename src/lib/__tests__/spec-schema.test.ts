import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import { parseAndHashSpec, hashSpecPreimage, SpecValidationError } from "@/lib/spec/hash";
import { MAX_SPEC_BYTES } from "@/lib/spec/schema";

const VALID_V1 = JSON.stringify({
  schema_version: 1,
  criteria: {
    min_artefacts: 8,
    exif_gps_within_m: { lat: -37.8136, lon: 144.9631, radius_m: 100 },
    captured_after: "task_funding_block_timestamp",
    provenance: { require_camera_model: true, reject_c2pa_ai_generated: true },
    phash_max_similarity_to: { source: ["ff00ff00ff00ff00"], threshold: 0.85 },
  },
});

describe("acceptance spec hashing (CC-084)", () => {
  it("hashes the verbatim bytes to a pinned vector", () => {
    // The worker recomputes this from the stored preimage and submitWork reverts
    // SpecAckMismatch on any difference, so a change to the preimage is a change to
    // what the chain will accept. Pinned as a literal so that fails here, not there.
    const preimage = '{"schema_version":1,"criteria":{"min_artefacts":8}}';

    expect(hashSpecPreimage(preimage)).toBe(
      "0x95488785ad9098de2b47cd8e031a10509c63766075e0b2de83f5a1902e8466a4",
    );
    // Same idiom as toTaskId in src/lib/contracts/escrow.ts.
    expect(hashSpecPreimage(preimage)).toBe(keccak256(toHex(preimage)));
    expect(parseAndHashSpec(preimage).hash).toBe(hashSpecPreimage(preimage));
  });

  it("returns the agent's exact string as the preimage, unmodified", () => {
    const spaced = '{ "schema_version" : 1 , "criteria" : { } }';
    const parsed = parseAndHashSpec(spaced);

    expect(parsed.preimage).toBe(spaced);
    expect(parsed.hash).toBe(keccak256(toHex(spaced)));
  });

  it("does NOT canonicalise — key order and whitespace change the hash", () => {
    // This is the whole design: three parties must agree on the preimage, so we never
    // reserialise. If this test ever passes with equal hashes, someone has introduced a
    // canonicaliser and the worker's verification now depends on reproducing it exactly.
    const a = '{"schema_version":1,"criteria":{"min_artefacts":8}}';
    const b = '{"criteria":{"min_artefacts":8},"schema_version":1}';
    const c = '{"schema_version": 1, "criteria": {"min_artefacts": 8}}';

    expect(parseAndHashSpec(a).hash).not.toBe(parseAndHashSpec(b).hash);
    expect(parseAndHashSpec(a).hash).not.toBe(parseAndHashSpec(c).hash);

    // ...while all three are the same spec semantically.
    expect(parseAndHashSpec(a).spec).toEqual(parseAndHashSpec(b).spec);
  });
});

describe("acceptance spec validation (CC-084)", () => {
  it("accepts the ADR-0001 D3 worked example", () => {
    const parsed = parseAndHashSpec(VALID_V1);

    expect(parsed.version).toBe(1);
    expect(parsed.hasNoCriteria).toBe(false);
    expect(parsed.spec.criteria.min_artefacts).toBe(8);
  });

  it("flags a spec with no criteria rather than accepting it silently", () => {
    // ADR-0001: no criteria means no failing verdict is possible, so the task can only
    // resolve to the worker. Legitimate for an uncheckable category, never an accident.
    const parsed = parseAndHashSpec('{"schema_version":1,"criteria":{}}');

    expect(parsed.hasNoCriteria).toBe(true);
  });

  it("rejects an unsupported schema_version by name, not by field errors", () => {
    expect(() => parseAndHashSpec('{"schema_version":99,"criteria":{}}')).toThrow(
      /unsupported schema_version 99/,
    );
  });

  it("rejects a missing schema_version", () => {
    expect(() => parseAndHashSpec('{"criteria":{}}')).toThrow(/schema_version/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAndHashSpec("{not json")).toThrow(SpecValidationError);
    expect(() => parseAndHashSpec("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a JSON array or scalar", () => {
    expect(() => parseAndHashSpec("[]")).toThrow(/must be a JSON object/);
    expect(() => parseAndHashSpec('"a string"')).toThrow(/must be a JSON object/);
  });

  it("rejects unknown criteria keys instead of ignoring them", () => {
    // A key we do not check would be displayed to the worker as a requirement and then
    // never enforced — the goalpost problem arriving through the back door.
    expect(() =>
      parseAndHashSpec(
        '{"schema_version":1,"criteria":{"min_artefacts":8,"vibes_check":true}}',
      ),
    ).toThrow(SpecValidationError);
  });

  it("rejects out-of-range geography and thresholds", () => {
    expect(() =>
      parseAndHashSpec(
        '{"schema_version":1,"criteria":{"exif_gps_within_m":{"lat":-91,"lon":0,"radius_m":10}}}',
      ),
    ).toThrow(/lat/);

    expect(() =>
      parseAndHashSpec(
        '{"schema_version":1,"criteria":{"phash_max_similarity_to":{"source":["ff00"],"threshold":1.5}}}',
      ),
    ).toThrow(/threshold/);

    // `source` carries the reference hashes themselves, never a name for a set: the
    // checker is offline and cannot resolve a label into anything, so a bare string
    // has to be refused at intake rather than silently never enforced.
    expect(() =>
      parseAndHashSpec(
        '{"schema_version":1,"criteria":{"phash_max_similarity_to":{"source":"listing_images","threshold":0.85}}}',
      ),
    ).toThrow(/source/);

    // At least one reference, or the criterion commits to nothing.
    expect(() =>
      parseAndHashSpec(
        '{"schema_version":1,"criteria":{"phash_max_similarity_to":{"source":[],"threshold":0.85}}}',
      ),
    ).toThrow(/source/);
  });

  it("accepts an ISO timestamp as well as the funding-block sentinel", () => {
    expect(() =>
      parseAndHashSpec(
        '{"schema_version":1,"criteria":{"captured_after":"2026-08-16T00:00:00Z"}}',
      ),
    ).not.toThrow();

    expect(() =>
      parseAndHashSpec('{"schema_version":1,"criteria":{"captured_after":"yesterday"}}'),
    ).toThrow(SpecValidationError);
  });

  it("rejects a preimage over the size cap before parsing it", () => {
    const huge = `{"schema_version":1,"criteria":{},"pad":"${"x".repeat(MAX_SPEC_BYTES)}"}`;

    expect(() => parseAndHashSpec(huge)).toThrow(/exceeds/);
  });
});
