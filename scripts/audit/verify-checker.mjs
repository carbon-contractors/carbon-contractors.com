/**
 * verify-checker.mjs — READ-ONLY, fully offline. CC-083 / CC-085 / ADR-0003 D2.
 *
 * "The checker is running" is not the property worth holding; "the checker still returns
 * the right answers" is. A checker that is up and wrong is worse than one that is down,
 * because down eventually fails loudly and wrong never does.
 *
 * So this monitor is not a smoke test. It drives the committed canary evidence set
 * (src/lib/checker/canary/fixtures.ts) through the REAL pipeline — the raw spec preimage
 * through parseAndHashSpec, then evaluateEvidence, the same code a live verdict runs —
 * and asserts each case yields exactly its known-correct verdict. Any rule change that
 * alters an outcome anywhere in the pipeline fails here before it fails a real task.
 *
 * It also re-checks the two properties CC-083's acceptance hangs on, because they are the
 * ones a refactor is most likely to break silently:
 *   - byte-identical re-runs (same inputs → identical serialised verdict), and
 *   - every supported spec schema_version still covered by a canary case (A2.2 — a
 *     retired version must fail the fixture, not a live task).
 *
 * Needs no env, no chain, no network — it is the one monitor that cannot lie about why
 * it failed. Run under tsx because the checker and its fixtures are TypeScript under
 * src/lib (see the `exec: "tsx"` registry entry in run-monitors.mjs).
 *
 *   node scripts/audit/run-monitors.mjs --only=verify-checker
 *   node node_modules/tsx/dist/cli.mjs scripts/audit/verify-checker.mjs
 *
 * Exit codes: 0 every canary case matches its expected verdict · 1 any discrepancy
 */

import { CANARY_CASES } from "../../src/lib/checker/canary/fixtures";
import { evaluateEvidence } from "../../src/lib/checker/evaluator";
import { getCheckerHash } from "../../src/lib/checker/hash";
import { parseAndHashSpec } from "../../src/lib/spec/hash";
import { SUPPORTED_SPEC_VERSIONS } from "../../src/lib/spec/schema";

const line = (n = 74) => "=".repeat(n);

console.log(line());
console.log("Checker canary verification (offline) — CC-083 / CC-085");
console.log(line());

/** One entry per canary case: what diverged, as flat strings for the alert body. */
const problems = [];

for (const canary of CANARY_CASES) {
  const issues = [];

  let parsed;
  try {
    // The real pipeline, deliberately: a fixture that inlined already-parsed objects
    // would never notice spec parsing breaking.
    parsed = parseAndHashSpec(canary.specPreimage);
  } catch (err) {
    problems.push(`${canary.name}: spec preimage no longer parses — ${err.message}`);
    console.log(`INFO  ${canary.name.padEnd(34)} UNPARSEABLE SPEC — ${err.message}`);
    continue;
  }

  const verdict = evaluateEvidence(parsed.spec, canary.bundle, canary.context);
  const failedChecks = verdict.checks.filter((c) => !c.passed).map((c) => c.check).sort();
  const expected = [...canary.expectedFailedChecks].sort();

  if (verdict.passed !== canary.expectedPassed) {
    issues.push(
      `verdict.passed is ${verdict.passed}, expected ${canary.expectedPassed}`,
    );
  }
  if (JSON.stringify(failedChecks) !== JSON.stringify(expected)) {
    issues.push(
      `failing checks [${failedChecks.join(", ")}], expected [${expected.join(", ")}]`,
    );
  }

  // The pinned rules and the verdict must agree — a verdict stamped with a hash this
  // build did not produce cannot be re-run, which is the one thing D5 forbids.
  if (verdict.checkerHash !== getCheckerHash(verdict.ruleVersion)) {
    issues.push("verdict.checkerHash does not match getCheckerHash(ruleVersion)");
  }

  // Re-runnability, checked live on every run rather than only in the test suite.
  const again = evaluateEvidence(parsed.spec, canary.bundle, canary.context);
  if (JSON.stringify(again) !== JSON.stringify(verdict)) {
    issues.push("re-run produced a different serialised verdict");
  }

  if (issues.length > 0) {
    problems.push(`${canary.name}: ${issues.join("; ")}`);
    console.log(`INFO  ${canary.name.padEnd(34)} DIVERGED — ${issues.join("; ")}`);
  } else {
    const outcome = canary.expectedPassed ? "passed" : `failed as expected (${expected.join(", ")})`;
    console.log(`INFO  ${canary.name.padEnd(34)} ${outcome}`);
  }
}

// A2.2: retiring a schema version must fail HERE, not on a task pinned to it. This runs
// in the monitor as well as the test suite because the monitor is what catches it once
// the test suite of an archived build no longer runs.
const covered = new Set(CANARY_CASES.map((c) => parseAndHashSpec(c.specPreimage).version));
for (const version of SUPPORTED_SPEC_VERSIONS) {
  if (!covered.has(version)) {
    problems.push(`no canary case covers supported schema_version ${version}`);
    console.log(`INFO  schema-version coverage           GAP — no case for version ${version}`);
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("\n" + line());
console.log("VERDICT");
console.log(line());

if (problems.length === 0) {
  console.log(
    `  PASS — ${CANARY_CASES.length} canary case(s) match their expected verdicts;`,
  );
  console.log("  re-runs byte-identical; every supported schema_version covered.");
} else {
  console.log(`  FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log("  The checker disagrees with its own canary set. Any verdict it signs is");
  console.log("  unreproducible or wrong. First response is to PAUSE NEW TASK CREATION");
  console.log("  (ADR-0003 D4) — in-flight tasks resolve safely on their own clocks.");
  process.exitCode = 1;
}
console.log(line());
