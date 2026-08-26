import { describe, it, expect } from "vitest";
import { CANARY_CASES, CANARY_PASS_ALL } from "@/lib/checker/canary/fixtures";
import { evaluateEvidence } from "@/lib/checker/evaluator";
import { parseAndHashSpec } from "@/lib/spec/hash";
import { AcceptanceSpecV1, SUPPORTED_SPEC_VERSIONS } from "@/lib/spec/schema";

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

// ── Completeness ─────────────────────────────────────────────────────────────
//
// Why this block exists.
//
// The canary set had six cases — one pass-all and five single-check failures — and
// `phash_max_similarity_to` was not among them. It was also the one check implemented
// backwards: the evaluator requires similarity >= threshold (a floor) while CC-084 and
// spec/format.ts both specify a cap. The check with no failing canary was the check
// that was wrong, and verify-checker could not have caught it, because a criterion
// nothing exercises produces no signal either way.
//
// That is not a coincidence worth relying on staying rare. A criterion added without a
// failing case is invisible to the monitor that exists to prove the checker is right,
// so the fixture set's own completeness has to be asserted rather than assumed.
//
// Two directions, both load-bearing:
//
//   1. Every criterion the SCHEMA accepts must be exercised by the full spec, i.e. the
//      evaluator must actually emit a check for it. A criterion the schema accepts and
//      the evaluator ignores is the goalpost problem the `.strict()` note in
//      spec/schema.ts warns about, arriving through a different door.
//   2. Every check the evaluator EMITS must be failed by at least one canary case.
//
// Coverage is asserted against each case's declared `expectedFailedChecks` — the
// fixture's stated intent — not against a fresh evaluator run. Deriving it from
// behaviour would let an evaluator bug satisfy the coverage check it is supposed to
// be measured by.
describe("canary set completeness (CC-083)", () => {
  /**
   * Criteria the fixture set deliberately does not exercise yet, and why.
   *
   * This is not a suppression list. Both directions are asserted below: an entry that
   * becomes covered fails as stale, and an entry naming a check the evaluator does not
   * emit fails as dead. It cannot silently outlive its reason.
   */
  const KNOWN_UNCOVERED: Record<string, string> = {
    // Empty, and worth keeping empty. `phash_max_similarity_to` lived here for the
    // length of one commit, between this check being written and the cap semantics
    // being settled; CANARY_FAIL_PHASH_REUPLOAD closed it. An entry here is a
    // criterion the monitor cannot vouch for, so it should be rare and short-lived.
  };

  /** Every check name the evaluator emits when every criterion is present. */
  const emittedChecks = (() => {
    const parsed = parseAndHashSpec(CANARY_PASS_ALL.specPreimage);
    const verdict = evaluateEvidence(
      parsed.spec,
      CANARY_PASS_ALL.bundle,
      CANARY_PASS_ALL.context,
    );
    return verdict.checks.map((c) => c.check);
  })();

  /** Top-level criterion keys the schema accepts, read off the zod shape. */
  const criterionKeys = (() => {
    const shape = (
      AcceptanceSpecV1 as unknown as {
        shape?: { criteria?: { shape?: Record<string, unknown> } };
      }
    ).shape?.criteria?.shape;
    if (!shape) {
      throw new Error(
        "could not read CriteriaV1's shape off AcceptanceSpecV1 — the zod version or " +
          "the schema's structure changed. Fix this reader rather than deleting the " +
          "assertions below; a completeness check that cannot enumerate the criteria " +
          "silently passes for every one of them.",
      );
    }
    return Object.keys(shape);
  })();

  it("reads a non-empty criterion list off the schema", () => {
    // Guards the two assertions below against vacuous success.
    expect(criterionKeys.length).toBeGreaterThan(0);
    expect(emittedChecks.length).toBeGreaterThan(0);
  });

  it("emits a check for every criterion the schema accepts", () => {
    // `provenance` emits dotted sub-checks (provenance.require_camera_model), so a
    // criterion counts as emitted when any check equals it or is prefixed by it.
    for (const key of criterionKeys) {
      const emitted = emittedChecks.some(
        (check) => check === key || check.startsWith(`${key}.`),
      );
      expect(
        emitted,
        `criterion '${key}' is accepted by AcceptanceSpecV1 but the evaluator emits no ` +
          `check for it against the pass-all spec. Either the full canary spec omits ` +
          `it, or the checker ignores it — the second is a criterion shown to the ` +
          `worker and silently unenforced.`,
      ).toBe(true);
    }
  });

  it("has a failing canary case for every check the evaluator emits", () => {
    const failedSomewhere = new Set(
      CANARY_CASES.flatMap((c) => c.expectedFailedChecks),
    );

    const uncovered = emittedChecks.filter((check) => !failedSomewhere.has(check));
    const unexplained = uncovered.filter((check) => {
      const root = check.split(".")[0];
      return !(check in KNOWN_UNCOVERED) && !(root in KNOWN_UNCOVERED);
    });

    expect(
      unexplained,
      `these checks are never failed by any canary case, so verify-checker cannot ` +
        `tell whether they are right: ${unexplained.join(", ")}. Add a case that fails ` +
        `exactly that check (see CANARY_FAIL_GPS_RADIUS for the shape), or add it to ` +
        `KNOWN_UNCOVERED above with the reason it cannot be written yet.`,
    ).toEqual([]);
  });

  it("holds no stale or dead KNOWN_UNCOVERED entries", () => {
    const failedSomewhere = new Set(
      CANARY_CASES.flatMap((c) => c.expectedFailedChecks),
    );

    for (const key of Object.keys(KNOWN_UNCOVERED)) {
      const matching = emittedChecks.filter(
        (check) => check === key || check.startsWith(`${key}.`),
      );

      expect(
        matching.length,
        `KNOWN_UNCOVERED lists '${key}' but the evaluator emits no such check. The ` +
          `criterion was renamed or removed — delete the entry.`,
      ).toBeGreaterThan(0);

      const nowCovered = matching.every((check) => failedSomewhere.has(check));
      expect(
        nowCovered,
        `KNOWN_UNCOVERED still lists '${key}', but a canary case now fails it. The ` +
          `gap is closed — delete the entry so the exemption cannot outlive its reason.`,
      ).toBe(false);
    }
  });
});
