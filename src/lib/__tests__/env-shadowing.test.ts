/**
 * env-shadowing.test.ts — the forms a hand-edited env file actually takes.
 *
 * These exist because the first version of this parser claimed to be "deliberately loose"
 * and was the opposite. Written as a template literal, `\s` is not a recognised escape, so
 * `` `^\s*${name}` `` compiled to `^s*NAME` — matching literal `s` characters. It worked on
 * `NAME=value` (because `s*` matches zero of them) and silently missed `  NAME=value` and
 * `NAME = value`.
 *
 * My own verification used the one form that worked. CodeQL caught it. So the indentation
 * and spacing cases below are the point of this file, not filler.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readEnvFileValue,
  findShadowedVars,
  explainShadowing,
} from "@/lib/env-shadowing";

const NAME = "PREVIEW_BASE_URL";
const URL_A = "https://correct.vercel.app";

describe("readEnvFileValue", () => {
  it("reads the plain form", () => {
    expect(readEnvFileValue(`${NAME}=${URL_A}`, NAME)).toBe(URL_A);
  });

  it("reads an INDENTED line", () => {
    // Missed entirely by the original regex.
    expect(readEnvFileValue(`    ${NAME}=${URL_A}`, NAME)).toBe(URL_A);
    expect(readEnvFileValue(`\t${NAME}=${URL_A}`, NAME)).toBe(URL_A);
  });

  it("reads spaces around the equals", () => {
    // Also missed entirely by the original regex.
    expect(readEnvFileValue(`${NAME} = ${URL_A}`, NAME)).toBe(URL_A);
    expect(readEnvFileValue(`  ${NAME}\t=\t${URL_A}  `, NAME)).toBe(URL_A);
  });

  it("strips matched quotes", () => {
    expect(readEnvFileValue(`${NAME}="${URL_A}"`, NAME)).toBe(URL_A);
    expect(readEnvFileValue(`${NAME}='${URL_A}'`, NAME)).toBe(URL_A);
  });

  it("leaves an unmatched quote alone", () => {
    // A stray quote is part of the value, not a delimiter. Stripping one side would report
    // a value the script is not actually using.
    expect(readEnvFileValue(`${NAME}="${URL_A}`, NAME)).toBe(`"${URL_A}`);
  });

  it("strips a separated trailing comment but not a URL fragment", () => {
    expect(readEnvFileValue(`${NAME}=${URL_A}   # the preview`, NAME)).toBe(URL_A);
    // `#` with no preceding whitespace is part of the value — a fragment, or a password.
    expect(readEnvFileValue(`${NAME}=${URL_A}#frag`, NAME)).toBe(`${URL_A}#frag`);
  });

  it("does not read a commented-out definition", () => {
    // The single most important negative: a commented line is not a definition, and treating
    // it as one would report a shadowing that does not exist.
    expect(readEnvFileValue(`# ${NAME}=${URL_A}`, NAME)).toBeNull();
    expect(readEnvFileValue(`   #${NAME}=${URL_A}`, NAME)).toBeNull();
  });

  it("does not match a different variable that ends with the same name", () => {
    expect(readEnvFileValue(`MY_${NAME}=${URL_A}`, NAME)).toBeNull();
  });

  it("returns null for an empty value", () => {
    // `VAR=` is the CC-097 blank case. Nothing is being shadowed by it.
    expect(readEnvFileValue(`${NAME}=`, NAME)).toBeNull();
    expect(readEnvFileValue(`${NAME}=   `, NAME)).toBeNull();
  });

  it("finds the variable among many lines", () => {
    const file = [
      "# comment",
      "OTHER=1",
      `  ${NAME} = ${URL_A}  # trailing`,
      "LAST=2",
    ].join("\n");
    expect(readEnvFileValue(file, NAME)).toBe(URL_A);
  });
});

describe("findShadowedVars", () => {
  function fileWith(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "env-shadow-"));
    const path = join(dir, ".env.local");
    writeFileSync(path, contents, "utf8");
    return path;
  }

  it("reports a variable the environment is overriding", () => {
    const path = fileWith(`  ${NAME} = ${URL_A}`);
    const found = findShadowedVars(path, [NAME], { [NAME]: "https://stale.vercel.app" });
    expect(found).toEqual([
      { name: NAME, inFile: URL_A, inUse: "https://stale.vercel.app" },
    ]);
  });

  it("says nothing when they agree", () => {
    const path = fileWith(`${NAME}=${URL_A}`);
    expect(findShadowedVars(path, [NAME], { [NAME]: URL_A })).toEqual([]);
  });

  it("says nothing when the environment has no value", () => {
    // Not shadowing — this is the normal case where --env-file actually applies.
    const path = fileWith(`${NAME}=${URL_A}`);
    expect(findShadowedVars(path, [NAME], {})).toEqual([]);
  });

  it("says nothing when the file does not define it", () => {
    const path = fileWith("OTHER=1");
    expect(findShadowedVars(path, [NAME], { [NAME]: "https://stale" })).toEqual([]);
  });

  it("returns nothing rather than throwing when the file is absent", () => {
    // Called on every run; a missing .env.local is normal in CI and must not be fatal.
    expect(findShadowedVars("/definitely/not/here/.env.local", [NAME], {})).toEqual([]);
  });
});

describe("explainShadowing", () => {
  it("names both values and the exact command to fix it", () => {
    const text = explainShadowing({ name: NAME, inFile: URL_A, inUse: "https://stale" });
    expect(text).toContain(URL_A);
    expect(text).toContain("https://stale");
    // The interpolation here was broken once too — it printed a literal ${name}.
    expect(text).toContain(`Remove-Item Env:\\${NAME}`);
    expect(text).not.toContain("${name}");
  });
});
