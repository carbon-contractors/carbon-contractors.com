/**
 * backup-export.ts — the ADR-0006 D8 off-vendor export engine (CC-107).
 *
 * D8, accepted 2026-08-26: "Registration and reference data (humans, categories)
 * is backed up, exported off-vendor on a schedule, and restore-tested at least
 * once before mainnet. Task content — descriptions, acceptance-spec preimages,
 * verdict breakdowns — lives in storage that is not backed up."
 *
 * This module is the "exported off-vendor on a schedule" half. Scheduling is
 * out of scope here exactly as it was for the CC-087 retention engine: the
 * cron route at src/app/api/cron/backup-export/route.ts wires this up.
 *
 * ## What leaves the vendor, and why an allowlist
 *
 * BCP-DR "Data and backups" names the backed-up set: the humans registry,
 * notification_channels, and task metadata that is either already on-chain or
 * non-sensitive. Everything else is either deliberately unbacked (task content)
 * or ephemeral operational state that a restore does not need.
 *
 * Every table exports through an explicit column allowlist. `select *` is
 * never used, on purpose: a future migration that adds a content column to
 * `tasks` (or a PII column anywhere) is then *structurally unable* to leak —
 * it is simply absent from the export until someone deliberately adds it,
 * which is a code review, not an accident. The inverse failure (a column
 * dropped from the schema but still listed) fails loudly at export time as a
 * PostgREST error, not silently as a missing field.
 *
 * Defence in depth: FORBIDDEN_COLUMNS names the columns that must never appear
 * in an allowlist. assertSpecCompliance() throws at startup if the two ever
 * intersect — so adding `task_description` to the tasks allowlist is not a
 * diff that can slip through; it is an error the engine refuses to boot with.
 *
 * ## The excluded tables, named rather than implied
 *
 * - `task_description_history` — task content by definition (CC-087's scratch
 *   copy). Exporting it would falsify the same deletion guarantee as exporting
 *   the live columns.
 * - `sessions` — `token_hash` is a bearer-credential hash; a backup of it is a
 *   session-hijack kit. Session state is ephemeral and reconstructs.
 * - `used_nonces`, `mcp_challenges` — replay-protection and challenge state
 *   with expiry semantics; restoring old ones is at best useless and at worst
 *   widens a replay window. Deliberately absent.
 *
 * ## Verification on every run
 *
 * Each object is PUT to R2, then GET back and sha256-compared before the run
 * is called a success. The manifest carries per-table hashes so any future
 * restore can be verified against the manifest independently of R2's own
 * integrity story. This is D8's "restore-tested" instinct applied on every
 * run rather than once before mainnet; the one-time full restore test is
 * still tracked (CC-108 acceptance).
 *
 * ## Failure visibility
 *
 * A table that fails to export does not abort the others — same shape as the
 * retention engine — but it lands in `failures`, the route logs it at error
 * level, and the heartbeat (if configured) is *not* pinged. Silence is the
 * success signal; the dead-man's switch turns silence into noise, exactly as
 * scripts/audit/run-monitors.mjs documents for the monitors.
 */

import { createHash } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { getSupabaseAdmin } from "./client";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";
import { putObject, getObject, R2Credentials } from "@/lib/r2";

/** Version of the export rule in force. Bump when the table set, column
 *  allowlists, layout or verification rule change. Stamped into every
 *  manifest so an audit can tell which rule produced a given object. */
export const EXPORT_RULE_VERSION = "cc107.2026-09-16.1";

/** Rows per page. Keyset pagination on `id` — stable under concurrent
 *  inserts, unlike offset pagination, which can skip or duplicate rows when
 *  another writer commits mid-export. */
export const EXPORT_PAGE_SIZE = 1000;

/**
 * Columns that must never appear in any allowlist. The keys include tables
 * that are not exported at all — listing `task_description_history: ["*"]`
 * means "any column of this table is forbidden", which assertSpecCompliance
 * enforces by rejecting the table outright from the spec list.
 */
export const FORBIDDEN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ["task_description", "acceptance_spec"],
  task_description_history: ["*"],
  sessions: ["token_hash"],
};

/** Tables that must never be in the export spec, with the reason kept beside
 *  the name so nobody has to re-derive it from the ADR. */
const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  task_description_history: "task content by definition (CC-087 scratch copy)",
  sessions: "token_hash is a bearer-credential hash; sessions are ephemeral",
  used_nonces: "replay-protection state; restoring old nonces is useless-to-harmful",
  mcp_challenges: "expired challenge state; no restore value",
};

/** One table's export specification. */
export interface TableSpec {
  name: string;
  /** Explicit allowlist. Never "*", never implied. */
  columns: readonly string[];
  /** Why this table is in the Tier 1 set — one line, quoted in the manifest. */
  note: string;
}

/**
 * The Tier 1 reference set per BCP-DR "Data and backups" plus the two tables
 * the ADR's wording implies: `stake_slashes` (the "stakes" half of this
 * ticket — on-chain facts with off-chain attribution) and
 * `task_content_deletion_log` (the CC-087 deletion record, which D9 requires
 * to be durable and auditable).
 *
 * Column lists mirror the live schema as verified 2026-09-16. `stake_slashes`
 * (migration 023) is not applied to the production project yet; the exporter
 * treats its absence as `absent`, distinct from `0 rows`, and says so in the
 * manifest — "table not there yet" and "table empty" are different facts.
 */
export const TIER1_TABLES: readonly TableSpec[] = [
  {
    name: "humans",
    columns: [
      "id",
      "wallet",
      "categories",
      "rate_usdc",
      "availability",
      "reputation_score",
      "created_at",
      "updated_at",
    ],
    note: "the worker registry — D8's named registration data",
  },
  {
    name: "notification_channels",
    columns: [
      "id",
      "contractor_id",
      "type",
      "address",
      "accepts_auto_booking",
      "created_at",
      "updated_at",
    ],
    note: "how workers are reachable — D8's named registration data",
  },
  {
    name: "tasks",
    columns: [
      "id",
      "payment_request_id",
      "from_agent_wallet",
      "to_human_wallet",
      "amount_usdc",
      "deadline_unix",
      "offer_expiry_unix",
      "review_window_seconds",
      "spec_hash",
      "spec_schema_version",
      "status",
      "tx_hash",
      "escrow_contract",
      "funded_at",
      "idempotency_key",
      "content_purged_at",
      "content_purge_rule",
      "created_at",
      "updated_at",
    ],
    note: "metadata only: hashes, wallets, amounts, timestamps — all on-chain or non-sensitive. task_description and acceptance_spec are absent by allowlist",
  },
  {
    name: "task_content_deletion_log",
    columns: ["id", "task_id", "payment_request_id", "retention_rule_version", "deleted_at"],
    note: "the CC-087 deletion record — D9 requires it durable and auditable",
  },
  {
    name: "stake_slashes",
    columns: ["id", "wallet", "amount_usdc", "payment_request_id", "tx_hash", "slashed_at"],
    note: "resolution-time slash attribution (migration 023) — the on-chain event plus the why",
  },
];

/**
 * Startup guard: refuse to export if the spec violates the D8 boundary.
 * Exported for the tests; called at the top of exportTier1ToR2.
 *
 * This is the load-bearing privacy control of the whole module. The allowlist
 * mechanism makes inclusion deliberate; this makes forbidden inclusion
 * impossible — the engine would rather fail the backup than falsify
 * privacy.md's deletion guarantee.
 */
export function assertSpecCompliance(specs: readonly TableSpec[] = TIER1_TABLES): void {
  for (const spec of specs) {
    const excluded = EXCLUDED_TABLES[spec.name];
    if (excluded) {
      throw new Error(
        `Export spec includes excluded table ${spec.name}: ${excluded}. ` +
          "A backup containing it would violate ADR-0006 D8.",
      );
    }
    const forbidden = FORBIDDEN_COLUMNS[spec.name] ?? [];
    const overlap = spec.columns.filter((c) =>
      forbidden.includes("*") || forbidden.includes(c),
    );
    if (overlap.length > 0) {
      throw new Error(
        `Export spec for ${spec.name} includes forbidden column(s): ${overlap.join(", ")}. ` +
          "ADR-0006 D8: task content must never enter a backed-up store.",
      );
    }
  }
}

/** One table's outcome. `absent` is distinct from `exported` with 0 rows. */
export interface TableExportResult {
  name: string;
  status: "exported" | "absent" | "failed";
  rows: number;
  bytes?: number;
  sha256?: string;
  key?: string;
  /** Read-back verification passed (sha256 of the GET body === sha256 PUT). */
  verified?: boolean;
  error?: string;
}

export interface BackupRunSummary {
  rule_version: string;
  /** ISO timestamp of the run — also the object-key timestamp. */
  generated_at: string;
  /** Supabase project ref, derived from SUPABASE_URL. Keeps exports from
   *  different projects (e.g. a future mainnet DB) in disjoint prefixes. */
  project_ref: string;
  /** The R2 prefix every object of this run landed under. */
  prefix: string;
  tables: TableExportResult[];
  /** True only when every spec table exported (or is legitimately absent)
   *  AND every read-back verification passed. */
  ok: boolean;
}

/** NDJSON body: one JSON object per line, newline-terminated. Pure, exported
 *  for tests. Deterministic given row order (keyset on id). */
export function buildNdjson(rows: Record<string, unknown>[]): Buffer {
  if (rows.length === 0) return Buffer.alloc(0);
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** The manifest written beside the data. Carries per-table hashes so a
 *  restore can be verified against it years later, plus the exclusion record
 *  so the manifest itself documents what is deliberately not in it. */
export interface BackupManifest {
  rule_version: string;
  generated_at: string;
  project_ref: string;
  /** Postgres engine major, recorded so a restore knows what produced it. */
  engine?: string;
  tables: Array<{
    name: string;
    status: TableExportResult["status"];
    rows: number;
    bytes?: number;
    sha256?: string;
    columns: readonly string[];
    note: string;
  }>;
  excludes: Record<string, string>;
}

export function buildManifest(
  summary: Omit<BackupRunSummary, "ok" | "tables">,
  results: TableExportResult[],
  specs: readonly TableSpec[] = TIER1_TABLES,
): BackupManifest {
  return {
    rule_version: summary.rule_version,
    generated_at: summary.generated_at,
    project_ref: summary.project_ref,
    tables: results.map((r) => {
      const spec = specs.find((s) => s.name === r.name);
      return {
        name: r.name,
        status: r.status,
        rows: r.rows,
        bytes: r.bytes,
        sha256: r.sha256,
        columns: spec?.columns ?? [],
        note: spec?.note ?? "",
      };
    }),
    excludes: { ...EXCLUDED_TABLES },
  };
}

/** Derive the Supabase project ref from the DB URL (db.<ref>.supabase.co). */
export function projectRefFromUrl(url: string): string {
  const m = url.match(/^https:\/\/db\.([a-z0-9]{20})\.supabase\.co/i);
  if (m) return m[1];
  // Fallback for pooler/other URL shapes: take the first label after db or the
  // hostname's leftmost label, and refuse empty.
  try {
    const host = new URL(url).hostname;
    const label = host.split(".")[0] === "db" ? host.split(".")[1] : host.split(".")[0];
    if (label && /^[a-z0-9-]+$/i.test(label)) return label;
  } catch {
    /* fall through */
  }
  throw new Error(`Cannot derive a Supabase project ref from SUPABASE_URL`);
}

function r2CredentialsFromConfig(): R2Credentials & { bucket: string; heartbeat?: string } {
  const config = getConfig();
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, BACKUP_R2_BUCKET } = config;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !BACKUP_R2_BUCKET) {
    throw new Error(
      "R2 backup target not configured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY and BACKUP_R2_BUCKET must all be set (CC-108). " +
        "Refusing to run a partial export.",
    );
  }
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: BACKUP_R2_BUCKET,
    heartbeat: config.BACKUP_HEARTBEAT_URL,
  };
}

/** PostgREST error codes that mean "this table does not exist (yet)". */
const ABSENT_CODES = new Set(["42P01", "PGRST205"]);

/** Fetch every row of one spec table via keyset pagination on id. */
async function fetchAllRows(
  supabase: SupabaseClient<Database>,
  spec: TableSpec,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const select = spec.columns.join(",");
  let lastId: string | null = null;

  for (;;) {
    // supabase-js's typed .from() wants a literal relation name; the export
    // is spec-driven so the name arrives as a plain string. Cast at exactly
    // this boundary — the row shape is re-asserted through `unknown` below,
    // and assertSpecCompliance() has already validated the name against the
    // D8 boundary.
    let query = supabase
      .from(spec.name as "humans")
      .select(select)
      .order("id", { ascending: true })
      .limit(EXPORT_PAGE_SIZE);
    if (lastId !== null) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) {
      if (ABSENT_CODES.has(error.code ?? "")) throw new AbsentTableError(spec.name);
      throw new Error(`${spec.name} select failed: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    all.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    lastId = String(rows[rows.length - 1].id);
  }
  return all;
}

/** Thrown when a spec table is not in the live schema (e.g. migration 023 not
 *  yet applied). Distinct from a query failure. */
class AbsentTableError extends Error {
  constructor(public readonly tableName: string) {
    super(`table ${tableName} not present in schema`);
    this.name = "AbsentTableError";
  }
}

/**
 * Run one Tier 1 export: fetch every spec table, build NDJSON + manifest,
 * PUT each object to R2, read each back and hash-compare, then PUT the
 * manifest last (so its existence implies the run's objects landed).
 *
 * Does not throw on per-table failure — the summary carries it. Throws only
 * on misconfiguration (spec violation, missing R2 env) where running at all
 * would be wrong.
 */
export async function exportTier1ToR2(
  now: Date = new Date(),
): Promise<BackupRunSummary> {
  assertSpecCompliance();

  const config = getConfig();
  const target = r2CredentialsFromConfig();
  const projectRef = projectRefFromUrl(config.SUPABASE_URL);
  const supabase = getSupabaseAdmin();

  const generatedAt = now.toISOString();
  const y = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16).replace(":", "");
  const prefix = `tier1-backup/${projectRef}/${y}/${hhmm}Z`;

  const results: TableExportResult[] = [];

  for (const spec of TIER1_TABLES) {
    try {
      const rows = await fetchAllRows(supabase, spec);
      const body = buildNdjson(rows);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const key = `${prefix}/${spec.name}.ndjson`;

      await putObject(target, target.bucket, key, body, "application/x-ndjson");

      // Read-back verification: hash what R2 returns, not what we sent.
      const readBack = await getObject(target, target.bucket, key);
      const readHash = createHash("sha256").update(readBack).digest("hex");
      const verified = readHash === sha256;

      if (!verified) {
        // Do not fail the whole run; record and continue. The heartbeat stays
        // unpinged, which is what makes this visible.
        log("error", "backup_export_verify_mismatch", {
          table: spec.name,
          key,
        });
      }

      results.push({
        name: spec.name,
        status: "exported",
        rows: rows.length,
        bytes: body.byteLength,
        sha256,
        key,
        verified,
      });
    } catch (err) {
      if (err instanceof AbsentTableError) {
        // Legitimate state (migration 023 not applied yet). Recorded, not
        // failed — but visible in every manifest until it exists.
        results.push({ name: err.tableName, status: "absent", rows: 0 });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      log("error", "backup_export_table_failed", { table: spec.name, error: message });
      results.push({ name: spec.name, status: "failed", rows: 0, error: message });
    }
  }

  const ok =
    results.every((r) => (r.status === "exported" && r.verified === true) || r.status === "absent") &&
    results.some((r) => r.status === "exported");

  const partialSummary: Omit<BackupRunSummary, "ok" | "tables"> = {
    rule_version: EXPORT_RULE_VERSION,
    generated_at: generatedAt,
    project_ref: projectRef,
    prefix,
  };

  // Manifest last: its existence in the prefix implies the run completed.
  const manifest = buildManifest(partialSummary, results);
  const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  try {
    const manifestKey = `${prefix}/manifest.json`;
    await putObject(target, target.bucket, manifestKey, manifestBody, "application/json");
    const readBack = await getObject(target, target.bucket, manifestKey);
    const manifestVerified =
      createHash("sha256").update(readBack).digest("hex") ===
      createHash("sha256").update(manifestBody).digest("hex");
    if (!manifestVerified) {
      log("error", "backup_export_manifest_verify_mismatch", { key: manifestKey });
    }
    (manifest as BackupManifest & { key?: string; verified?: boolean }).key = manifestKey;
    (manifest as BackupManifest & { verified?: boolean }).verified = manifestVerified;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "backup_export_manifest_failed", { error: message });
    results.push({ name: "manifest.json", status: "failed", rows: 0, error: message });
  }

  const summary: BackupRunSummary = {
    ...partialSummary,
    tables: results,
    ok: ok && !results.some((r) => r.name === "manifest.json" && r.status === "failed"),
  };
  // Manifest read-back failure must also poison ok.
  if ((manifest as BackupManifest & { verified?: boolean }).verified === false) {
    summary.ok = false;
  }

  log("info", "backup_export_run", {
    rule_version: EXPORT_RULE_VERSION,
    prefix,
    ran_at: generatedAt,
    ok: summary.ok,
    tables: summary.tables.map((t) => `${t.name}:${t.status}${t.verified === false ? "(unverified)" : ""}`),
  });

  // Dead-man's switch: ping only on full success, so silence stays the
  // success signal (run-monitors.mjs Path 2 philosophy).
  if (summary.ok && target.heartbeat) {
    try {
      await fetch(target.heartbeat);
    } catch (err) {
      log("error", "backup_export_heartbeat_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
