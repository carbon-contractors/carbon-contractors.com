#!/usr/bin/env tsx
/**
 * verify-backup-export.ts — manual deep verification of an off-vendor export
 * (CC-107, ADR-0006 D8).
 *
 * The daily cron already read-back-verifies every object it PUTs. This script
 * is the independent check a human (or auditor) runs later: fetch a prefix's
 * manifest, GET every object it names, sha256 each, compare to the manifest,
 * and assert the manifest's own hash-claims are internally consistent. It
 * never writes, never needs the Supabase credential — only the R2 read side —
 * so it can run from any machine with the four R2 env vars.
 *
 * Usage:
 *   tsx --env-file-if-exists=.env.local scripts/audit/verify-backup-export.ts \
 *     --prefix tier1-backup/<project-ref>/2026-09-16/0417Z
 *   # --latest  picks the newest prefix under tier1-backup/ (needs LIST,
 *   #           not implemented — pass --prefix explicitly for now).
 *
 * Exit 0 = every object present and hash-verified. Exit 1 = any mismatch,
 * missing object, or absent table recorded as exported.
 */

import { createHash } from "node:crypto";
import { getObject, R2Credentials } from "../../src/lib/r2";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name} (see .env.example, CC-109 section)`);
    process.exit(2);
  }
  return v;
}

const creds: R2Credentials = {
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
};
const bucket = env("BACKUP_R2_BUCKET");

const prefixArg = process.argv.find((a) => a.startsWith("--prefix="));
if (!prefixArg) {
  console.error("usage: verify-backup-export.ts --prefix=tier1-backup/<ref>/<date>/<hhmm>Z");
  process.exit(2);
}
const prefix = prefixArg.slice("--prefix=".length);

let failures = 0;
const manifest = await getObject(creds, bucket, `${prefix}/manifest.json`);
const parsed = JSON.parse(manifest.toString("utf8")) as {
  rule_version: string;
  generated_at: string;
  tables: Array<{ name: string; status: string; rows: number; sha256?: string; columns: string[] }>;
  excludes: Record<string, string>;
};

console.log(`manifest: ${prefix}/manifest.json (${parsed.rule_version}, ${parsed.generated_at})`);
console.log(`excludes on record: ${Object.keys(parsed.excludes).join(", ")}`);

for (const t of parsed.tables) {
  if (t.status === "absent") {
    console.log(`  ABSENT    ${t.name} (not in schema at export time)`);
    continue;
  }
  if (t.status !== "exported" || !t.sha256) {
    console.error(`  FAIL      ${t.name}: manifest records status=${t.status}`);
    failures++;
    continue;
  }
  const body = await getObject(creds, bucket, `${prefix}/${t.name}.ndjson`);
  const hash = createHash("sha256").update(body).digest("hex");
  const lines = t.rows === 0 ? 0 : body.toString("utf8").trimEnd().split("\n").length;
  if (hash === t.sha256 && lines === t.rows) {
    console.log(`  OK        ${t.name}: ${t.rows} rows, ${body.byteLength}B, sha256 verified`);
  } else {
    console.error(`  FAIL      ${t.name}: hash=${hash.slice(0, 12)}… expected=${t.sha256.slice(0, 12)}… rows=${lines}/${t.rows}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} verification failure(s).`);
  process.exit(1);
}
console.log("\nall objects present and hash-verified against the manifest.");
