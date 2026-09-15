/**
 * route.ts — GET /api/cron/backup-export (CC-107, ADR-0006 D8)
 *
 * The scheduler the off-vendor export engine was written for. Runs daily at
 * 04:17 UTC — one hour after /api/cron/retention's 03:17 prune, so the export
 * reflects the post-prune state of `tasks` rather than racing it. The only
 * ordering that matters is backup-after-prune; nothing else in the day
 * depends on when this lands.
 *
 * ## Why a Vercel cron, again
 *
 * Same argument as the retention route (PR #147): the engine needs the
 * service-role key, which already lives — and only lives — in Vercel's
 * environment. Scheduling the export from frankenfarm, GitHub Actions or
 * anywhere else would mean copying the most powerful credential in the stack
 * to a second location purely for scheduling convenience. The job runs where
 * the credential already is.
 *
 * ## Fails closed, twice
 *
 * /api/* bypasses the coming-soon gate, so this route is internet-reachable
 * the moment it deploys, and it exfiltrates registration data to an external
 * bucket. Two controls, same polarity as the retention route:
 *
 * 1. CRON_SECRET — unset (or blank) means refuse, not run. An unset secret is
 *    a misconfiguration, not permission.
 * 2. R2 target — unset (or blank) means refuse with 503 and a pointer to
 *    CC-108, not a partial run. Until the PO provisions the bucket and the
 *    four env vars, this endpoint does nothing except say so. That is the
 *    correct posture for a pipeline whose credentials do not exist yet: a
 *    scheduled task that fails loudly every day until it is configured beats
 *    one that silently never runs.
 *
 * ## What it returns
 *
 * The run summary minus the data itself: per-table status/rows/bytes/sha256,
 * never row content. A failed table does not 500 the whole response — the
 * summary carries it — but `ok: false` keeps the heartbeat un-pinged, which
 * is how the dead-man's switch notices (run-monitors.mjs Path 2).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { exportTier1ToR2 } from "@/lib/db/backup-export";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

/** Constant-time compare that tolerates a length mismatch without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let cronSecret: string | undefined;
  let r2Configured: boolean;
  try {
    const config = getConfig();
    cronSecret = config.CRON_SECRET;
    r2Configured = Boolean(
      config.R2_ACCOUNT_ID &&
        config.R2_ACCESS_KEY_ID &&
        config.R2_SECRET_ACCESS_KEY &&
        config.BACKUP_R2_BUCKET,
    );
  } catch (err) {
    return safeErrorResponse(err, "backup_export_cron_config_invalid");
  }

  if (!cronSecret) {
    log("error", "backup_export_cron_secret_not_configured", {});
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET is not configured. Refusing to run an unauthenticated backup export.",
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !secretMatches(provided, cronSecret)) {
    log("warn", "backup_export_cron_unauthorized", { had_header: header.length > 0 });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!r2Configured) {
    // Provisioning is a PO action (CC-108). Refuse loudly, daily, until done.
    log("error", "backup_export_target_not_configured", {});
    return NextResponse.json(
      {
        ok: false,
        error:
          "R2 backup target not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
          "R2_SECRET_ACCESS_KEY, BACKUP_R2_BUCKET). See CC-108 — refusing to run.",
      },
      { status: 503 },
    );
  }

  try {
    const summary = await exportTier1ToR2();

    return NextResponse.json({
      ok: summary.ok,
      rule_version: summary.rule_version,
      generated_at: summary.generated_at,
      project_ref: summary.project_ref,
      prefix: summary.prefix,
      tables: summary.tables.map((t) => ({
        name: t.name,
        status: t.status,
        rows: t.rows,
        bytes: t.bytes,
        sha256: t.sha256,
        verified: t.verified,
        ...(t.error ? { error: t.error } : {}),
      })),
    });
  } catch (err: unknown) {
    log("error", "backup_export_cron_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return safeErrorResponse(err, "backup_export_cron_failed");
  }
}
