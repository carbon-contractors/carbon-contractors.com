import { describe, it, expect } from "vitest";
import {
  formatCriteria,
  formatSpecForDisplay,
  NO_CRITERIA_ROW,
} from "@/lib/spec/format";
import { parseAndHashSpec } from "@/lib/spec/hash";
import type { AcceptanceSpec } from "@/lib/spec/schema";

/** The ADR-0001 D3 worked example, as an agent would send it. */
const FULL_V1 = parseAndHashSpec(
  JSON.stringify({
    schema_version: 1,
    criteria: {
      min_artefacts: 8,
      exif_gps_within_m: { lat: -37.8136, lon: 144.9631, radius_m: 100 },
      captured_after: "task_funding_block_timestamp",
      provenance: { require_camera_model: true, reject_c2pa_ai_generated: true },
      phash_max_similarity_to: { source: "listing_images", threshold: 0.85 },
    },
  }),
).spec as AcceptanceSpec;

describe("spec formatting (CC-084)", () => {
  it("formats every field of the full worked example, in schema order", () => {
    const rows = formatSpecForDisplay(FULL_V1);

    expect(rows.map((r) => r.key)).toEqual([
      "min_artefacts",
      "exif_gps_within_m",
      "captured_after",
      "provenance.require_camera_model",
      "provenance.reject_c2pa_ai_generated",
      "phash_max_similarity_to",
    ]);

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["min_artefacts"].value).toBe("At least 8");
    expect(byKey["exif_gps_within_m"].value).toBe(
      "-37.8136, 144.9631 — within 100 m",
    );
    expect(byKey["captured_after"].value).toBe(
      "The task's funding block timestamp",
    );
    expect(byKey["provenance.require_camera_model"].value).toBe("Yes");
    expect(byKey["provenance.reject_c2pa_ai_generated"].value).toBe("Rejected");
    expect(byKey["phash_max_similarity_to"].value).toBe(
      "No more than 0.85 similarity to listing_images",
    );

    // Every row is display-ready: no empty label, value or description.
    for (const row of rows) {
      expect(row.label).toMatch(/\S/);
      expect(row.value).toMatch(/\S/);
      expect(row.description).toMatch(/\S/);
    }
  });

  it("formats a partial spec — only the declared criteria appear", () => {
    const rows = formatCriteria({
      min_artefacts: 3,
      provenance: { reject_c2pa_ai_generated: true },
    });

    expect(rows.map((r) => r.key)).toEqual([
      "min_artefacts",
      "provenance.reject_c2pa_ai_generated",
    ]);
    expect(rows[0].value).toBe("At least 3");

    // An unset provenance sub-field renders nothing — the agent did not commit to it.
    const onlyCamera = formatCriteria({
      provenance: { require_camera_model: true },
    });
    expect(onlyCamera.map((r) => r.key)).toEqual([
      "provenance.require_camera_model",
    ]);
  });

  it("converts an ISO captured_after to a deterministic UTC string", () => {
    const rows = formatCriteria({ captured_after: "2026-08-16T14:05:09Z" });

    expect(rows[0].value).toBe("2026-08-16 14:05 UTC");
    // The sentinel and an explicit timestamp are rendered differently — the worker
    // must be able to tell a fixed-at-funding deadline from an absolute one.
    const sentinel = formatCriteria({
      captured_after: "task_funding_block_timestamp",
    });
    expect(sentinel[0].value).not.toBe(rows[0].value);
  });

  it("preserves the agent's numbers exactly — no rounding of GPS or thresholds", () => {
    const rows = formatCriteria({
      exif_gps_within_m: { lat: 51.507222, lon: -0.1275, radius_m: 25000 },
      phash_max_similarity_to: { source: "prior_uploads", threshold: 0.9 },
    });

    expect(rows[0].value).toBe("51.507222, -0.1275 — within 25000 m");
    expect(rows[1].value).toBe("No more than 0.9 similarity to prior_uploads");
  });

  it("handles negative provenance flags (require_camera_model: false)", () => {
    const rows = formatCriteria({
      provenance: { require_camera_model: false, reject_c2pa_ai_generated: false },
    });

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["provenance.require_camera_model"].value).toBe("No");
    expect(byKey["provenance.reject_c2pa_ai_generated"].value).toBe("Allowed");
  });

  it("returns the no-criteria indicator for empty criteria — never an empty array", () => {
    // A caller that rendered this as "no requirements listed" would be lying to the
    // worker in the dangerous direction: empty criteria means NOTHING can fail.
    expect(formatCriteria({})).toEqual([NO_CRITERIA_ROW]);
    expect(formatCriteria(undefined)).toEqual([NO_CRITERIA_ROW]);
    expect(formatCriteria(null)).toEqual([NO_CRITERIA_ROW]);
  });

  it("returns the no-criteria indicator for a null or missing spec", () => {
    expect(formatSpecForDisplay(null)).toEqual([NO_CRITERIA_ROW]);
    expect(formatSpecForDisplay(undefined)).toEqual([NO_CRITERIA_ROW]);
  });

  it("says plainly that a spec without criteria can only resolve to the worker", () => {
    const empty = parseAndHashSpec('{"schema_version":1,"criteria":{}}').spec;

    const rows = formatSpecForDisplay(empty);
    expect(rows).toEqual([NO_CRITERIA_ROW]);
    expect(NO_CRITERIA_ROW.label).toBe("No machine-checkable criteria");
    expect(NO_CRITERIA_ROW.description).toMatch(
      /cannot be withheld|only.*resolve/i,
    );
  });
});
