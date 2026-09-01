/**
 * env-shadowing.ts — detect when `.env.local` is being ignored.
 *
 * ## The hazard
 *
 * **`node --env-file` does not override a variable already in `process.env`.** Measured on
 * Node v24, 2026-09-01: with the file saying one thing and the shell another, the shell wins
 * silently.
 *
 * So editing `.env.local` has no effect on any variable also set in a PowerShell session or
 * the Windows user environment. The symptom is a script that keeps using a value you have
 * just changed and triple-checked, with nothing anywhere saying why.
 *
 * ## Why this is a module and not a helper inside one script
 *
 * It started as a local function in `verify-funding-lifecycle.ts`, and its regex was wrong:
 * written as a template literal, `\s` is not a recognised escape, so `` `^\s*${name}` ``
 * compiled to `^s*NAME` — matching literal `s` characters. It happened to work on
 * `NAME=value` (because `s*` matches zero of them) and silently missed `  NAME=value` and
 * `NAME = value`. CodeQL caught it; the hand-rolled check that "verified" it used the one
 * form that worked.
 *
 * `CLAUDE.md` points at this as something to copy into other scripts. Copy-paste is how that
 * bug would have spread, so it lives here with tests instead.
 */

import { readFileSync, existsSync } from "node:fs";

/** One variable whose file value is being overridden by the environment. */
export interface ShadowedVar {
  name: string;
  /** What `.env.local` says. */
  inFile: string;
  /** What `process.env` actually holds — the value that wins. */
  inUse: string;
}

/**
 * Parse one variable out of env-file contents.
 *
 * Deliberately loose, and *tested* for it: an indented line, spaces around the `=`, a quoted
 * value and a trailing comment are all normal in a hand-edited file, and none should defeat
 * the check. A `#`-commented line is not a definition and must not match.
 */
export function readEnvFileValue(contents: string, name: string): string | null {
  // `\\s` so the string carries `\s` through to the RegExp. In a template literal `\s` is
  // not an escape and collapses to `s` — which is the defect this module exists because of.
  const pattern = new RegExp(`^[ \\t]*${escapeForRegExp(name)}[ \\t]*=[ \\t]*(.*)$`, "m");
  const match = contents.match(pattern);
  if (!match) return null;

  let value = match[1].trim();
  // A trailing comment, but only when it is separated — `#` inside a URL fragment or a
  // password is part of the value.
  value = value.replace(/\s+#.*$/, "").trim();
  // Surrounding quotes, only as a matched pair.
  const quoted = value.match(/^(["'])(.*)\1$/);
  if (quoted) value = quoted[2];
  return value === "" ? null : value;
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which of `names` have a value in `envFilePath` that `process.env` is overriding.
 *
 * @param env Defaults to `process.env`; injectable so this is testable without mutating it.
 */
export function findShadowedVars(
  envFilePath: string,
  names: string[],
  env: Record<string, string | undefined> = process.env,
): ShadowedVar[] {
  if (!existsSync(envFilePath)) return [];

  let contents: string;
  try {
    contents = readFileSync(envFilePath, "utf8");
  } catch {
    return [];
  }

  const out: ShadowedVar[] = [];
  for (const name of names) {
    const inFile = readEnvFileValue(contents, name);
    const inUse = env[name];
    if (inFile && inUse && inFile !== inUse) {
      out.push({ name, inFile, inUse });
    }
  }
  return out;
}

/**
 * Human-readable explanation for one shadowed variable.
 *
 * **Prints values.** Only ever call this for names that are not secrets — a URL or a contract
 * address, never a key. The caller chooses the list; this cannot tell the difference.
 */
export function explainShadowing(v: ShadowedVar): string {
  return [
    `  WARNING — ${v.name} in .env.local is being IGNORED.`,
    `    .env.local says:  ${v.inFile}`,
    `    actually in use:  ${v.inUse}`,
    "    node --env-file does not override a variable already in the environment,",
    "    so a shell or Windows user variable wins. Clear it and re-run:",
    `      Remove-Item Env:\\${v.name}`,
  ].join("\n");
}
