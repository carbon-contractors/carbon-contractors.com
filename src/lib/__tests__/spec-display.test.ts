import { describe, it, expect } from "vitest";
import { parseSpecForDisplay } from "@/lib/spec/display";
import { formatSpecForDisplay, NO_CRITERIA_ROW } from "@/lib/spec/format";
import { parseAndHashSpec } from "@/lib/spec/hash";
import { MAX_SPEC_BYTES } from "@/lib/spec/schema";
import type { AcceptanceSpec } from "@/lib/spec/schema";

const FULL_V1_RAW = JSON.stringify({
  schema_version: 1,
  criteria: {
    min_artefacts: 8,
    exif_gps_within_m: { lat: -37.8136, lon: 144.9631, radius_m: 100 },
    captured_after: "task_funding_block_timestamp",
    provenance: { require_camera_model: true, reject_c2pa_ai_generated: true },
    phash_max_similarity_to: {
      source: ["ff00ff00ff00ff00", "0f0f0f0f0f0f0f0f"],
      threshold: 0.85,
    },
  },
});

/** The same spec through the checker's own parser — display must agree with it. */
const FULL_V1 = parseAndHashSpec(FULL_V1_RAW).spec as AcceptanceSpec;

describe("spec display parsing (NOR-323)", () => {
  it("renders a valid spec into the same rows formatSpecForDisplay produces", () => {
    const display = parseSpecForDisplay(FULL_V1_RAW);
    expect(display).toEqual({ ok: true, rows: formatSpecForDisplay(FULL_V1) });
  });

  it("treats an absent spec as no criteria, not as an error", () => {
    for (const raw of [null, undefined, ""]) {
      const display = parseSpecForDisplay(raw);
      expect(display).toEqual({ ok: true, rows: [NO_CRITERIA_ROW] });
    }
  });

  it("refuses to impersonate no-criteria when the stored spec is broken", () => {
    const cases: [string, string][] = [
      ["{not json", "not valid JSON"],
      ["[]", "not a JSON object"],
      ['{"criteria": {}}', "no numeric schema_version"],
      [
        JSON.stringify({ schema_version: 99, criteria: {} }),
        "unsupported schema_version 99",
      ],
      // .strict() — an unknown field is a schema mismatch, exactly as the checker sees it.
      [
        JSON.stringify({ schema_version: 1, criteria: {}, sneaky: true }),
        "does not match its declared schema",
      ],
    ];
    for (const [raw, reason] of cases) {
      const display = parseSpecForDisplay(raw);
      expect(display).toEqual({ ok: false, reason: expect.stringContaining(reason) });
    }
  });

  it("rejects a spec over the size limit before parsing it", () => {
    const display = parseSpecForDisplay("x".repeat(MAX_SPEC_BYTES + 1));
    expect(display).toEqual({
      ok: false,
      reason: expect.stringContaining("exceeds"),
    });
  });
});
