import { describe, it, expect } from "vitest";
import {
  evaluateEvidence,
  parseExifTimestamp,
} from "@/lib/checker/evaluator";
import { haversineDistanceM } from "@/lib/checker/haversine";
import { getCheckerHash, CHECKER_RULE_VERSION } from "@/lib/checker/hash";
import type { EvidenceArtifact, EvidenceBundle, TaskContext } from "@/lib/checker/types";
import type { AcceptanceSpec } from "@/lib/spec/schema";

const CONTEXT: TaskContext = { fundingBlockTimestamp: 1786838400 }; // 2026-08-16T00:00:00Z

function artifact(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return {
    uri: "https://agent-bucket.example/a.jpg",
    exif: {
      lat: -37.8131,
      lon: 144.9631,
      dateTimeOriginal: "2026-08-17T05:30:00Z",
      cameraMake: "Apple",
      cameraModel: "iPhone 15",
    },
    phash: "ff00ff00ff00ff01",
    ...overrides,
  };
}

function bundle(artifacts: EvidenceArtifact[]): EvidenceBundle {
  return { taskId: "t1", artifacts, submittedAt: "2026-08-17T06:00:00Z" };
}

function evaluate(criteria: Record<string, unknown>, artifacts: EvidenceArtifact[]) {
  return evaluateEvidence(
    { schema_version: 1, criteria } as AcceptanceSpec,
    bundle(artifacts),
    CONTEXT,
  );
}

describe("haversineDistanceM (CC-083)", () => {
  it("is zero at the same point", () => {
    expect(haversineDistanceM(-37.8136, 144.9631, -37.8136, 144.9631)).toBe(0);
  });

  it("is symmetric", () => {
    expect(haversineDistanceM(-37.8136, 144.9631, -37.8036, 144.9631)).toBe(
      haversineDistanceM(-37.8036, 144.9631, -37.8136, 144.9631),
    );
  });

  it("pins a known distance — one degree of latitude at the mean radius", () => {
    // 2πR/360 = 111194.9 m. Pinned so a changed earth radius (a checkerHash input)
    // fails here rather than moving every borderline GPS verdict silently.
    expect(haversineDistanceM(0, 0, 1, 0)).toBeCloseTo(111194.9, 0);
  });
});

describe("getCheckerHash (CC-083)", () => {
  it("is deterministic and pins a known vector", () => {
    expect(getCheckerHash()).toBe(getCheckerHash());
    // Pinned so a rule edit that changes the preimage fails here (see ./hash.ts) —
    // that failure means "new rule version required", not "fix the test".
    expect(getCheckerHash()).toBe(
      "0xe864356c931cae8e7daf4130a5956c6dfccb48f8ece0bbe4377e0960c9e4e7a9",
    );
  });

  it("selects by rule version and throws on an unknown one", () => {
    expect(getCheckerHash(CHECKER_RULE_VERSION)).toBe(getCheckerHash());
    expect(() => getCheckerHash(99)).toThrow(/unknown checker rule version 99/);
  });
});

describe("parseExifTimestamp (CC-083)", () => {
  it("accepts ISO-8601", () => {
    expect(parseExifTimestamp("2026-08-17T05:30:00Z")).toBe(1786944600);
  });

  it("accepts the raw EXIF colon-date form cameras actually emit", () => {
    expect(parseExifTimestamp("2026:08:17 05:30:00")).toBe(
      parseExifTimestamp("2026-08-17T05:30:00Z"),
    );
  });

  it("returns NaN for unparseable input rather than guessing", () => {
    expect(parseExifTimestamp("not a date")).toBeNaN();
    expect(parseExifTimestamp("")).toBeNaN();
  });
});

describe("evaluateEvidence — min_artefacts (CC-083)", () => {
  it("passes at exactly the minimum and fails below it", () => {
    const two = [artifact(), artifact()];
    expect(evaluate({ min_artefacts: 2 }, two).passed).toBe(true);
    const v = evaluate({ min_artefacts: 3 }, two);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/2 artefact\(s\) submitted, 3 required/);
  });
});

describe("evaluateEvidence — exif_gps_within_m (CC-083)", () => {
  it("passes inside the radius and fails outside it", () => {
    const near = artifact();
    const far = artifact({ exif: { ...artifact().exif!, lat: -37.8031 } });
    const criterion = { exif_gps_within_m: { lat: -37.8136, lon: 144.9631, radius_m: 100 } };

    expect(evaluate(criterion, [near]).passed).toBe(true);
    const v = evaluate(criterion, [far]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/beyond the 100 m radius/);
  });

  it("fails closed when an artefact has no GPS coordinates at all", () => {
    const noGps = artifact({ exif: { ...artifact().exif!, lat: undefined, lon: undefined } });
    const v = evaluate({ exif_gps_within_m: { lat: -37.8136, lon: 144.9631, radius_m: 100 } }, [noGps]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/no EXIF GPS/);
  });
});

describe("evaluateEvidence — captured_after (CC-083)", () => {
  it("compares against the funding block for the sentinel", () => {
    const criterion = { captured_after: "task_funding_block_timestamp" };
    expect(evaluate(criterion, [artifact()]).passed).toBe(true);

    const stale = artifact({ exif: { ...artifact().exif!, dateTimeOriginal: "2026-08-15T05:30:00Z" } });
    const v = evaluate(criterion, [stale]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/captured before the threshold/);
  });

  it("compares against a literal ISO timestamp when the spec pins one", () => {
    const criterion = { captured_after: "2026-08-17T00:00:00Z" };
    expect(evaluate(criterion, [artifact()]).passed).toBe(true); // 05:30 > 00:00
    const early = artifact({ exif: { ...artifact().exif!, dateTimeOriginal: "2026-08-16T12:00:00Z" } });
    expect(evaluate(criterion, [early]).passed).toBe(false);
  });

  it("fails closed when dateTimeOriginal is missing or unparseable", () => {
    const missing = artifact({ exif: { ...artifact().exif!, dateTimeOriginal: undefined } });
    const garbage = artifact({ exif: { ...artifact().exif!, dateTimeOriginal: "sometime" } });
    for (const a of [missing, garbage]) {
      const v = evaluate({ captured_after: "task_funding_block_timestamp" }, [a]);
      expect(v.passed).toBe(false);
      expect(v.checks[0].reason).toMatch(/missing a capture timestamp/);
    }
  });

  it("treats capture exactly at the funding block as on time", () => {
    const atFunding = artifact({ exif: { ...artifact().exif!, dateTimeOriginal: "2026-08-16T00:00:00Z" } });
    expect(evaluate({ captured_after: "task_funding_block_timestamp" }, [atFunding]).passed).toBe(true);
  });
});

describe("evaluateEvidence — provenance (CC-083)", () => {
  it("require_camera_model passes on make, model, or both — and fails on neither", () => {
    const makeOnly = artifact({ exif: { ...artifact().exif!, cameraModel: "" } });
    const modelOnly = artifact({ exif: { ...artifact().exif!, cameraMake: undefined } });
    const neither = artifact({ exif: { ...artifact().exif!, cameraMake: "  ", cameraModel: "" } });

    const criterion = { provenance: { require_camera_model: true } };
    expect(evaluate(criterion, [makeOnly]).passed).toBe(true);
    expect(evaluate(criterion, [modelOnly]).passed).toBe(true);
    const v = evaluate(criterion, [neither]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/no camera make or model/);
  });

  it("reject_c2pa_ai_generated fails only on a positive assertion", () => {
    const criterion = { provenance: { reject_c2pa_ai_generated: true } };
    expect(evaluate(criterion, [artifact()]).passed).toBe(true); // false
    expect(evaluate(criterion, [artifact({ c2paAiGenerated: undefined })]).passed).toBe(true); // absent
    const v = evaluate(criterion, [artifact({ c2paAiGenerated: true })]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/C2PA asserts AI generation/);
  });
});

describe("evaluateEvidence — phash_max_similarity_to (CC-083)", () => {
  // 64-bit references. similarity = 1 - hammingDistance / 64.
  const reference = "ff00ff00ff00ff00";
  const criterion = { phash_max_similarity_to: { source: [reference], threshold: 0.9 } };

  // A CAP, not a floor. The criterion exists so a worker cannot hand back material the
  // agent already had — its listing photos — as proof of new work. So high similarity
  // FAILS and a genuinely new photograph, which looks nothing like the reference, passes.
  // The checker had this inverted from 2026-08-21 to 2026-08-26; these tests are the
  // direction CC-084 and spec/format.ts always specified.

  it("passes a genuinely new artefact, dissimilar to the reference", () => {
    // Every bit inverted — similarity 0.0.
    expect(evaluate(criterion, [artifact({ phash: "00ff00ff00ff00ff" })]).passed).toBe(true);
  });

  it("fails a re-upload of the reference itself", () => {
    const v = evaluate(criterion, [artifact({ phash: reference })]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/exceed the 0.9 similarity cap/);
  });

  it("fails a near-duplicate above the cap", () => {
    // One bit of 64 → similarity 0.984, well above 0.9.
    const v = evaluate(criterion, [artifact({ phash: "ff00ff00ff00ff01" })]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/exceed the 0.9 similarity cap/);
  });

  it("treats the threshold as inclusive — at the cap passes, just above fails", () => {
    // 8 bits of 64 differ → similarity exactly 0.875.
    const eightBitsOff = "ff00ff00ff00ffff";
    const atCap = { phash_max_similarity_to: { source: [reference], threshold: 0.875 } };
    const justUnder = { phash_max_similarity_to: { source: [reference], threshold: 0.87 } };

    expect(evaluate(atCap, [artifact({ phash: eightBitsOff })]).passed).toBe(true);
    expect(evaluate(justUnder, [artifact({ phash: eightBitsOff })]).passed).toBe(false);
  });

  it("fails when an artefact matches ANY reference in the set", () => {
    const many = {
      phash_max_similarity_to: {
        source: [reference, "0f0f0f0f0f0f0f0f"],
        threshold: 0.9,
      },
    };
    // Dissimilar to the first, identical to the second — one match is a re-upload.
    const v = evaluate(many, [artifact({ phash: "0f0f0f0f0f0f0f0f" })]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/exceed the 0.9 similarity cap/);
  });

  it("fails closed on a missing hash, a width mismatch, and a non-hex hash", () => {
    // Fail-closed matters more under a cap than under a floor: an artefact whose hash
    // cannot be compared has not been shown NOT to be a re-upload, and "could not
    // check" must never read as "passed".
    for (const phash of [undefined, "ff00ff00", "not-hex-at-all"]) {
      const v = evaluate(criterion, [artifact({ phash })]);
      expect(v.passed, `phash=${phash}`).toBe(false);
      expect(v.checks[0].reason, `phash=${phash}`).toMatch(
        /no comparable perceptual hash/,
      );
    }
  });

  it("fails closed when a reference in the spec is not interpretable hex", () => {
    // The checker is offline — it cannot resolve a label by fetching anything. This is
    // why `source` carries hashes and not a name like "listing_images": a reference it
    // cannot interpret is a check that can never pass, and the schema now refuses one
    // at intake rather than letting it reach here.
    const v = evaluate(
      { phash_max_similarity_to: { source: ["listing_images"], threshold: 0.85 } },
      [artifact()],
    );
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/reference phash .* not a valid hex/);
  });

  it("accepts a 0x prefix on either side", () => {
    const prefixed = {
      phash_max_similarity_to: { source: [`0x${reference}`], threshold: 0.9 },
    };
    // Still a re-upload once both sides normalise, so this fails for the right reason.
    const v = evaluate(prefixed, [artifact({ phash: `0x${reference}` })]);
    expect(v.passed).toBe(false);
    expect(v.checks[0].reason).toMatch(/exceed the 0.9 similarity cap/);

    expect(
      evaluate(prefixed, [artifact({ phash: "0x00ff00ff00ff00ff" })]).passed,
    ).toBe(true);
  });
});

describe("evaluateEvidence — verdict shape and determinism (CC-083)", () => {
  const spec = {
    min_artefacts: 1,
    exif_gps_within_m: { lat: -37.8136, lon: 144.9631, radius_m: 100 },
    captured_after: "task_funding_block_timestamp",
    provenance: { require_camera_model: true, reject_c2pa_ai_generated: true },
    // Dissimilar to artifact()'s default phash, so the full spec passes: under a cap
    // the reference is material the artefact must NOT look like.
    phash_max_similarity_to: { source: ["00ff00ff00ff00ff"], threshold: 0.9 },
  } as const;

  it("emits results only for present criteria, in a fixed order", () => {
    const v = evaluate({ min_artefacts: 1 }, [artifact()]);
    expect(v.checks.map((c) => c.check)).toEqual(["min_artefacts"]);

    const full = evaluate(spec, [artifact()]);
    expect(full.checks.map((c) => c.check)).toEqual([
      "min_artefacts",
      "exif_gps_within_m",
      "captured_after",
      "provenance.require_camera_model",
      "provenance.reject_c2pa_ai_generated",
      "phash_max_similarity_to",
    ]);
    expect(full.passed).toBe(true);
  });

  it("produces a byte-identical verdict on re-run", () => {
    // CC-083 acceptance: same evidence and checkerHash → identical verdict, any machine,
    // offline. JSON.stringify stands in for the serialised verdict; the test suite's
    // fetch guard (CC-060) is what makes "offline" enforced rather than assumed.
    const first = JSON.stringify(evaluate(spec, [artifact()]));
    const second = JSON.stringify(evaluate(spec, [artifact()]));
    expect(second).toBe(first);
  });

  it("carries submittedAt as evaluatedAt — never a wall clock", () => {
    const v = evaluate({ min_artefacts: 1 }, [artifact()]);
    expect(v.evaluatedAt).toBe("2026-08-17T06:00:00Z");

    const bare = evaluateEvidence(
      { schema_version: 1, criteria: { min_artefacts: 1 } } as AcceptanceSpec,
      { taskId: "t1", artifacts: [artifact()] }, // no submittedAt
      CONTEXT,
    );
    expect(bare.evaluatedAt).toBe("");
  });

  it("stamps every verdict with the pinned checkerHash and rule version", () => {
    const v = evaluate({ min_artefacts: 1 }, [artifact()]);
    expect(v.checkerHash).toBe(getCheckerHash());
    expect(v.ruleVersion).toBe(CHECKER_RULE_VERSION);
  });

  it("throws loudly on a spec schema_version it cannot evaluate", () => {
    // A2.2: the checker must never mis-evaluate a newer schema — it must refuse.
    expect(() =>
      evaluateEvidence(
        { schema_version: 2, criteria: {} } as unknown as AcceptanceSpec,
        bundle([artifact()]),
        CONTEXT,
      ),
    ).toThrow(/checker cannot evaluate spec schema_version 2/);
  });
});
