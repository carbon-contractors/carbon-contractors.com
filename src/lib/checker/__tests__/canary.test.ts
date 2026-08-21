import { describe, it, expect } from "vitest";
import { CANARY_CASES } from "@/lib/checker/canary/fixtures";
import { evaluateEvidence } from "@/lib/checker/evaluator";
import { parseAndHashSpec } from "@/lib/spec/hash";
import { SUPPORTED_SPEC_VERSIONS } from "@/lib/spec/schema";

/**
 * The canary set is the ADR-0001 D5 re-runnability fixture and the input to
 * verify-checker (CC-085). It runs through the real pipeline — the spec as a raw
 * preimage through parseAndHashSpec, then evaluateEvidence — because a fixture that
 * inlines already-parsed objects would never notice the pipeline breaking.
 */
describe("canary evidence set (CC-083)", () => {
  it("has uniquely named cases", () => {
    const names = CANARY_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const testCase of CANARY_CASES) {
    describe(testCase.name, () => {
      const parsed = parseAndHashSpec(testCase.specPreimage);
      const verdict = evaluateEvidence(parsed.spec, testCase.bundle, testCase.context);

      it("yields its expected verdict", () => {
        expect(verdict.passed).toBe(testCase.expectedPassed);
      });

      it("fails exactly the expected checks and no others", () => {
        const failed = verdict.checks.filter((c) => !c.passed).map((c) => c.check);
        expect(failed.sort()).toEqual([...testCase.expectedFailedChecks].sort());
      });

      it("re-runs byte-identically", () => {
        const again = evaluateEvidence(
          parseAndHashSpec(testCase.specPreimage).spec,
          testCase.bundle,
          testCase.context,
        );
        expect(JSON.stringify(again)).toBe(JSON.stringify(verdict));
      });

      it("gives every failing check a reason", () => {
        // A failing check with no reason is unverifiable from the verdict alone, which
        // defeats the per-check breakdown ADR-0001 D4 commits to.
        for (const check of verdict.checks.filter((c) => !c.passed)) {
          expect(check.reason, check.check).toBeTruthy();
        }
      });
    });
  }

  it("covers every supported spec schema version (ADR-0001 A2.2)", () => {
    // Retiring a version must fail here — the fixture — rather than on a live task
    // pinned to a schema the checker quietly stopped understanding.
    const covered = new Set(
      CANARY_CASES.map((c) => parseAndHashSpec(c.specPreimage).version),
    );
    for (const version of SUPPORTED_SPEC_VERSIONS) {
      expect(covered, `schema_version ${version}`).toContain(version);
    }
  });
});
