#!/usr/bin/env node
/**
 * check-closure.mjs — refuse a backlog issue that closes without a record of what
 * was actually done.
 *
 * ## The gap this fills
 *
 * `CLAUDE.md` already states the rule: "Set `status: done`, bump `updated`, append what
 * was actually done and in which commit." Nothing enforced it, and on 2026-08-23 the
 * closing diff for `CC-087` was, in its entirety:
 *
 *     -status: todo          -updated: 2026-08-13
 *     +status: done          +updated: 2026-08-22
 *
 * No closing record, no commit reference. The engine it closed against
 * (`pruneExpiredTaskContent`) has no caller anywhere, and the ticket's own stated
 * Acceptance — "`verify-retention` passes" — names a monitor that does not exist. The
 * board said done; nothing had ever run.
 *
 * That is the failure this catches, and it catches it on the cheapest possible rule: a
 * status flip that adds no body is not a closure. `CC-081` is the harder neighbour —
 * it closed with a substantial record, but with Defect 2 still open — and only the
 * checkbox rule below reaches it, by forcing whoever closes a ticket to tick its
 * acceptance criteria one at a time. Converting an omission into a commission is the
 * whole intervention; a criterion you have to actively tick is one you have to read.
 *
 * ## Scope
 *
 * Only issues **transitioning into** a closed state in this diff are checked. The 66
 * already-closed issues are untouched — retro-fitting them would be archaeology, and a
 * check that starts by failing on history is a check that gets disabled. The new
 * convention arrives one ticket at a time, paid for by whoever closes it.
 *
 *   node scripts/check-closure.mjs                 # vs origin/master
 *   node scripts/check-closure.mjs --base <ref>    # vs an explicit ref
 *   node scripts/check-closure.mjs --all           # audit every closed issue (advisory)
 *
 * No dependencies — deliberately runnable before `npm install`.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "docs", "backlog");
const REL = "docs/backlog";

const CLOSED = new Set(["done", "wontfix"]);

/** A sha-shaped token that contains at least one digit, so prose like "faceted" cannot match. */
const COMMIT_REF = /#\d+|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/;

const argv = process.argv.slice(2);
const AUDIT_ALL = argv.includes("--all");
const baseArg = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : null;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function skip(why) {
  console.log(`SKIP — ${why}`);
  process.exit(0);
}

/** Parse the leading `---` frontmatter block. Same shape as backlog.mjs. */
function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const out = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Everything after the frontmatter block. */
function body(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return text;
  return text.slice(text.indexOf("\n", end + 1) + 1);
}

/** Non-empty trimmed body lines present in `next` but not in `prev`. */
function addedLines(prev, next) {
  const before = new Set(
    body(prev ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return body(next)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !before.has(l));
}

/** The `## Acceptance` section, or null. Ends at the next `## ` heading. */
function acceptanceSection(text) {
  const lines = body(text).split("\n");
  const start = lines.findIndex((l) => /^##\s+Acceptance\b/i.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;

/** Validate one closing transition. Returns { problems: [], warnings: [] }. */
function validateClosure(id, oldText, newText, fm) {
  const problems = [];
  const warnings = [];
  const added = addedLines(oldText, newText);

  if (oldText) {
    const oldFm = parseFrontmatter(oldText) ?? {};
    if (oldFm.updated && oldFm.updated === fm.updated) {
      problems.push(
        `\`updated:\` is still ${fm.updated}. CLAUDE.md: "Set status: done, bump updated, ` +
          `append what was actually done and in which commit."`,
      );
    }
  }

  if (added.length === 0) {
    problems.push(
      `the diff flips frontmatter and adds nothing to the body. A closure has to say ` +
        `what was actually done — this is the CC-087 shape exactly, and CC-087 shipped ` +
        `an engine that nothing calls.`,
    );
  } else if (fm.status === "done" && !COMMIT_REF.test(added.join("\n"))) {
    problems.push(
      `the closing note references no commit or PR. Add the PR number (#123) or the ` +
        `implementing sha, so \`git log --grep=${id}\` reconstructs the story.`,
    );
  }

  const acceptance = acceptanceSection(newText);
  if (acceptance === null) {
    warnings.push(
      `no "## Acceptance" section — nothing states what closing it was supposed to mean.`,
    );
  } else {
    const boxes = acceptance.split("\n").map((l) => l.match(CHECKBOX)).filter(Boolean);
    if (boxes.length === 0) {
      problems.push(
        `"## Acceptance" is prose, not checkboxes. Convert it to "- [ ] ..." items and ` +
          `tick each one. Reading the criteria individually is the point: CC-081 closed ` +
          `with a full write-up and Defect 2 still open.`,
      );
    } else {
      const unticked = boxes.filter((m) => m[1] === " ").map((m) => m[2].trim());
      if (unticked.length > 0) {
        problems.push(
          `${unticked.length} acceptance criterion/criteria not ticked:\n` +
            unticked.map((t) => `        - [ ] ${t}`).join("\n") +
            `\n      Either meet them, or leave the issue open and say what is outstanding.`,
        );
      }
    }
  }

  return { problems, warnings };
}

// ── Gather the issues to check ───────────────────────────────────────────────

/** [{ id, path, oldText|null, newText, fm }] */
const closing = [];

if (AUDIT_ALL) {
  for (const f of readdirSync(DIR).filter((f) => /^CC-\d+\.md$/.test(f))) {
    const newText = readFileSync(join(DIR, f), "utf8");
    const fm = parseFrontmatter(newText);
    if (!fm || !CLOSED.has(fm.status)) continue;
    closing.push({ id: f.replace(/\.md$/, ""), path: `${REL}/${f}`, oldText: null, newText, fm });
  }
} else {
  if (!git(["rev-parse", "--git-dir"], { allowFail: true })) skip("not a git repository");

  const candidates = baseArg
    ? [baseArg]
    : process.env.GITHUB_BASE_REF
      ? [`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF]
      : ["origin/master", "master"];

  let base = null;
  for (const ref of candidates) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true })) {
      base = ref;
      break;
    }
  }

  if (!base) {
    // Loud rather than silent in CI: a gate that cannot see its base is not passing,
    // it is not running, and those must not look the same.
    if (process.env.GITHUB_ACTIONS) {
      console.error(
        `Could not resolve a base ref from: ${candidates.join(", ")}.\n` +
          `The checkout needs full history — set 'fetch-depth: 0' on actions/checkout.\n`,
      );
      process.exit(1);
    }
    skip(`no base ref among ${candidates.join(", ")} (pass --base <ref>)`);
  }

  const mergeBase = git(["merge-base", base, "HEAD"], { allowFail: true })?.trim() || base;
  const changed = (git(["diff", "--name-only", mergeBase, "--", REL], { allowFail: true }) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^docs\/backlog\/CC-\d+\.md$/.test(l));

  for (const path of changed) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) continue; // deleted — backlog.mjs and CLAUDE.md cover that
    const newText = readFileSync(abs, "utf8");
    const fm = parseFrontmatter(newText);
    if (!fm || !CLOSED.has(fm.status)) continue;

    const oldText = git(["show", `${mergeBase}:${path}`], { allowFail: true });
    const oldFm = oldText ? parseFrontmatter(oldText) : null;
    // Already closed at the base, and still closed: not a transition.
    if (oldFm && CLOSED.has(oldFm.status)) continue;

    closing.push({ id: path.match(/(CC-\d+)/)[1], path, oldText, newText, fm });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (closing.length === 0) {
  console.log("OK - no backlog issue is being closed in this diff.");
  process.exit(0);
}

let failed = 0;
const advisory = AUDIT_ALL;

for (const issue of closing) {
  const { problems, warnings } = validateClosure(issue.id, issue.oldText, issue.newText, issue.fm);

  for (const w of warnings) console.log(`  warn  ${issue.id}: ${w}`);

  if (problems.length === 0) {
    console.log(`  ok    ${issue.id} closes as ${issue.fm.status}`);
    continue;
  }

  failed++;
  console.error(`\n  ${issue.id} cannot close as ${issue.fm.status} (${issue.path}):`);
  for (const p of problems) console.error(`      - ${p}`);
}

if (failed === 0) {
  console.log(`\nOK - ${closing.length} issue closure(s) carry a record.`);
  process.exit(0);
}

if (advisory) {
  console.log(
    `\n${failed} of ${closing.length} closed issue(s) predate this check (--all is advisory).`,
  );
  process.exit(0);
}

console.error(
  `\n${failed} issue closure(s) have no usable record.\n\n` +
    `Closing the loop is part of the job (CLAUDE.md): set status, bump updated, append\n` +
    `what was actually done and in which commit, then run node scripts/backlog.mjs.\n` +
    `If the work is not finished, the honest move is to leave it open and say what is\n` +
    `outstanding — CC-081 did that correctly in its commit message and then closed anyway.\n`,
);
process.exit(1);
