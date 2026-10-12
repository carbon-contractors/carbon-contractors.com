/**
 * check-audit.mjs — CI's dependency audit, with a dated allowlist.
 *
 * ## Why not plain `npm audit --audit-level=high`
 *
 * That step has one failure mode it cannot express: an advisory with no patched release.
 * On 2026-10-12 GHSA-vfj7-8cjw-p6xm marked every version of `braces` vulnerable. It reaches
 * this repo only through eslint-config-next → fast-glob → micromatch, a lint-time dev
 * dependency that never ships, and npm's only offered "fix" was a breaking downgrade of
 * eslint-config-next to 14.x. Plain `npm audit` left two choices: a permanently red build,
 * or `--omit=dev`, which would also stop catching the next compromised build-tool package.
 *
 * ## Behaviour
 *
 * Runs `npm audit --json` and fails on any high or critical advisory **except** those listed
 * in `scripts/audit-allowlist.json`. Each entry carries a `review_by` date, and an entry past
 * that date fails the build on its own, so an exception cannot quietly outlive the reason it
 * was granted. An entry that no longer matches anything is reported so it can be removed.
 * Moderate and low advisories are reported but never fail, matching the old --audit-level.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/** The GHSA id from an advisory URL, e.g. https://github.com/advisories/GHSA-xxxx-xxxx-xxxx. */
export function advisoryId(advisory) {
  const fromUrl = typeof advisory.url === "string" ? advisory.url.split("/").pop() : "";
  return fromUrl || String(advisory.source ?? "");
}

/**
 * Every distinct advisory in an `npm audit --json` (v2) report.
 *
 * A package's `via` lists either advisory objects or the names of dependencies it is
 * vulnerable through. The objects are the advisories themselves, so collecting them across
 * every entry finds each one exactly where it lives; the name strings add nothing new.
 */
export function collectAdvisories(report) {
  const seen = new Map();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via);
      if (!seen.has(id)) {
        seen.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Splits the report's advisories against the allowlist as of `today` (YYYY-MM-DD).
 * Pure, so the tests can pin it without running npm.
 */
export function evaluate(report, allowlist, today) {
  const advisories = collectAdvisories(report);
  const expired = allowlist.filter((e) => e.review_by < today);
  const live = new Map(allowlist.filter((e) => e.review_by >= today).map((e) => [e.id, e]));

  const blocking = [];
  const allowed = [];
  const reportedOnly = [];
  for (const a of advisories) {
    if (!BLOCKING.has(a.severity)) reportedOnly.push(a);
    else if (live.has(a.id)) allowed.push(a);
    else blocking.push(a);
  }
  const matched = new Set(advisories.map((a) => a.id));
  const unused = allowlist.filter((e) => !matched.has(e.id));
  return { blocking, allowed, reportedOnly, expired, unused };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const allowlist = JSON.parse(readFileSync(join(here, "audit-allowlist.json"), "utf8"));

  // npm audit exits non-zero whenever it finds anything, so the exit code says nothing; the
  // JSON is the result. An unparseable body is a failure, never a pass.
  const run = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error("FAIL — npm audit did not return JSON:");
    console.error(run.stderr || run.stdout);
    process.exit(1);
  }
  if (report.error) {
    console.error(`FAIL — npm audit errored: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const { blocking, allowed, reportedOnly, expired, unused } = evaluate(report, allowlist, today);
  const line = (a) => `  ${a.severity.padEnd(8)} ${a.package}  ${a.id}  ${a.title}`;

  if (reportedOnly.length) {
    console.log(`Reported, not blocking (below high):\n${reportedOnly.map(line).join("\n")}`);
  }
  if (allowed.length) {
    console.log(`Allowlisted (scripts/audit-allowlist.json):\n${allowed.map(line).join("\n")}`);
  }
  for (const e of unused) {
    console.log(`NOTE — allowlist entry ${e.id} (${e.package}) no longer matches anything; remove it.`);
  }
  for (const e of expired) {
    console.error(`FAIL — allowlist entry ${e.id} (${e.package}) passed its review date ${e.review_by}.`);
  }
  if (blocking.length) {
    console.error(`FAIL — high or critical advisories:\n${blocking.map(line).join("\n")}`);
  }
  if (blocking.length || expired.length) process.exit(1);
  console.log("PASS — no high or critical advisories outside the allowlist.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
