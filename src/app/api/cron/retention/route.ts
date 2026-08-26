/**
 * route.ts — GET /api/cron/retention (CC-087, ADR-0002 D4/D9)
 *
 * The scheduler `pruneExpiredTaskContent` was written for and never got. The engine
 * shipped in PR #130 and CC-087 was closed, but nothing ever called it — so task
 * descriptions and acceptance specs have been accumulating past their retention window
 * while `/learn` module 7 tells workers *"task content is deleted after settlement"*.
 * This is the caller.
 *
 * ## Why a Vercel cron rather than a GitHub Actions schedule
 *
 * Pruning needs the **service role** key: `tasks` denies every command to `anon` and
 * `authenticated` (migration 015), and the RPC writes. That key already lives in Vercel's
 * environment because the app cannot function without it. Scheduling this from Actions
 * instead would mean copying the most powerful credential in the stack into a second
 * place — GitHub repository secrets — purely for scheduling convenience. `monitors.yml`
 * deliberately carries only `SUPABASE_ANON_KEY` for that reason.
 *
 * So the job runs where the credential already is. Vercel Pro (CC-063) allows arbitrary
 * cron schedules; the entry lives in `vercel.json`.
 *
 * ## Authentication fails closed
 *
 * `/api/*` bypasses the coming-soon gate, so this route is publicly reachable the moment
 * it deploys, and it deletes data. Vercel sends `Authorization: Bearer $CRON_SECRET` on
 * cron invocations when that variable is set.
 *
 * **If `CRON_SECRET` is unset the route refuses to run at all** rather than running
 * unauthenticated. That is the same polarity `getRateLimitConfig` uses: a security control
 * that cannot read its own configuration must not come up permissive. The cost of getting
 * this backwards is an internet-reachable endpoint that deletes rows.
 *
 * ## What it returns
 *
 * The `ADR-0002` D9 deletion record: rule version, cutoff, and per-task identifiers with
 * timestamps. Identifiers and timing only — never the deleted content, which the engine
 * never reads in the first place (its candidate SELECT lists no content column).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { pruneExpiredTaskContent, RETENTION_RULE_VERSION } from "@/lib/db/retention";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

/** Constant-time compare that tolerates a length mismatch without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on differing lengths, which would itself be an oracle.
  // Compare against a fixed-size digest-shaped buffer by padding to the longer length.
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path costs roughly the same.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let cronSecret: string | undefined;
  try {
    cronSecret = getConfig().CRON_SECRET;
  } catch (err) {
    return safeErrorResponse(err, "retention_cron_config_invalid");
  }

  if (!cronSecret) {
    // Fail closed. An unset secret is a misconfiguration, not permission to run.
    log("error", "retention_cron_secret_not_configured", {});
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET is not configured. Refusing to run an unauthenticated retention sweep.",
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !secretMatches(provided, cronSecret)) {
    // No detail in the response and no secret material in the log line.
    log("warn", "retention_cron_unauthorized", {
      had_header: header.length > 0,
    });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await pruneExpiredTaskContent();

    return NextResponse.json({
      ok: true,
      rule_version: summary.rule_version,
      cutoff: summary.cutoff,
      considered: summary.considered,
      pruned: summary.pruned.length,
      skipped: summary.skipped.length,
      failed: summary.failed.length,
      // The auditable deletion record (D9). Ids and timestamps, never content.
      deletions: summary.pruned.map((p) => ({
        payment_request_id: p.payment_request_id,
        deleted_at: p.deleted_at,
      })),
      // Surfaced so a permanently unprunable row is visible rather than silently
      // retried forever — the engine already logs each one at error level.
      failures: summary.failed.map((f) => f.payment_request_id),
    });
  } catch (err: unknown) {
    log("error", "retention_cron_failed", {
      retention_rule_version: RETENTION_RULE_VERSION,
      error: err instanceof Error ? err.message : String(err),
    });
    return safeErrorResponse(err, "retention_cron_failed");
  }
}
