/**
 * check-encoding.mjs — detect (and optionally repair) double-encoded UTF-8.
 *
 * ## What went wrong, and why nothing caught it
 *
 * On 2026-08-16 a conflict resolution run through Windows PowerShell corrupted 248 lines
 * across CLAUDE.md, docs/Lessons-Learned.md and docs/backlog/CC-025.md. `Get-Content`
 * without `-Encoding` reads a BOM-less file as the system ANSI codepage (CP-1252) on
 * Windows PowerShell 5.1, so every multi-byte character became mojibake in the string;
 * writing it back out as UTF-8 then double-encoded it. `—` (E2 80 94) became `â€"`.
 *
 * The result is still **valid UTF-8**, so no encoding check, linter, or `git` setting
 * objects. `.gitattributes` pins line endings, not encoding, and `git ls-files --eol`
 * reports lf/lf on a thoroughly corrupted file — the axis that was already known was
 * verified, and its neighbour was not.
 *
 * Worse, the tool that corrupts is the tool that displays: PowerShell renders *clean*
 * UTF-8 as mojibake too, so corrupted and healthy files look identical in a terminal.
 * The damage was visible in output twice before anyone read it as damage.
 *
 * ## Usage
 *
 *   node scripts/audit/check-encoding.mjs          # report, exit 1 if any found (CI)
 *   node scripts/audit/check-encoding.mjs --fix    # repair in place
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FIX = process.argv.includes("--fix");

// CP-1252's 0x80–0x9F block. 0xA0–0xFF map straight to U+00A0–U+00FF.
const CP1252_HIGH = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

const RUN = new RegExp(
  `[\\u0080-\\u00FF${Object.keys(CP1252_HIGH).join("")}]+`,
  "g",
);

function toCp1252(run) {
  const bytes = Buffer.alloc(run.length);
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    const code = ch.codePointAt(0);
    if (CP1252_HIGH[ch] !== undefined) bytes[i] = CP1252_HIGH[ch];
    else if (code >= 0x80 && code <= 0xff) bytes[i] = code;
    else return null; // not representable — leave the run alone
  }
  return bytes;
}

/**
 * Repair only runs that are unambiguously double-encoded: they must re-decode as valid
 * UTF-8 AND change. A genuine standalone "é" is byte E9, which is not valid UTF-8 on its
 * own, so it fails the test and is left untouched. That asymmetry is what makes this safe
 * to run over the whole tree rather than a hand-picked list.
 */
function repair(text) {
  let count = 0;
  const out = text.replace(RUN, (run) => {
    const bytes = toCp1252(run);
    if (!bytes) return run;
    const decoded = bytes.toString("utf8");
    if (decoded.includes("�") || decoded === run) return run;
    // Re-encoding must reproduce the original bytes exactly, or this is a coincidence.
    if (!Buffer.from(decoded, "utf8").equals(bytes)) return run;
    count++;
    return decoded;
  });
  return { out, count };
}

const files = execFileSync("git", ["ls-files"], { maxBuffer: 64 * 1024 * 1024 })
  .toString("utf8")
  .split("\n")
  .filter((f) => f && !/\.(png|jpg|jpeg|gif|ico|woff2?|pdf|lock)$/i.test(f));

let bad = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const { out, count } = repair(text);
  if (count === 0) continue;
  bad++;
  const lines = text.split("\n").filter((l) => repair(l).count > 0).length;
  if (FIX) {
    writeFileSync(f, Buffer.from(out, "utf8")); // Buffer, not a string+encoding pair
    console.log(`FIXED  ${f} — ${count} sequence(s) on ${lines} line(s)`);
  } else {
    console.error(`MOJIBAKE  ${f} — ${count} sequence(s) on ${lines} line(s)`);
  }
}

if (bad === 0) {
  console.log(`OK — no double-encoded UTF-8 in ${files.length} tracked files`);
  process.exit(0);
}
if (FIX) {
  console.log(`\nRepaired ${bad} file(s). Re-run without --fix to confirm.`);
  process.exit(0);
}
console.error(
  `\n${bad} file(s) contain double-encoded UTF-8. Repair with:\n` +
    `  node scripts/audit/check-encoding.mjs --fix\n\n` +
    `Cause is almost always a Windows PowerShell round trip: \`Get-Content\` without\n` +
    `-Encoding reads BOM-less UTF-8 as CP-1252. Use node, \`git show\`, or\n` +
    `\`Get-Content -Encoding utf8\` when rewriting tracked files.\n`,
);
process.exit(1);
