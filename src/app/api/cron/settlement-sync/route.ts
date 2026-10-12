/**
 * route.ts — GET /api/cron/settlement-sync (CC-080)
 *
 * The scheduler for `syncSettledTasks` — the settlement observer CC-080 deferred.
 * Settlement is a transaction between the parties and the escrow; the app sends
 * none of it, so a row only learns it was paid (or refunded) by asking the chain.
 * See `src/lib/db/settlement-sync.ts` for the mapping and why it polls.
 *
 * Hourly. Nothing here is time-critical to the minute — a settled task's row
 * reaching `completed` an hour late costs the worker one concurrency slot for
 * that hour, and retention's window is measured in days from the transition.
 *
 * ## Same fail-closed posture as the retention route
 *
 * `/api/*` bypasses the coming-soon gate, so this route is publicly reachable the
 * moment it deploys, and it writes task status with the service-role key. If
 * `CRON_SECRET` is unset (or blank) it refuses to run rather than running
 * unauthenticated; a wrong or missing bearer is a 401. The retention route's
 * header has the full argument for running this in Vercel rather than Actions.
 *
 * ## What it returns
 *
 * Counts, plus the transitions it made and the ids it could not process —
 * identifiers and statuses only. The sync never selects task content.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { syncSettledTasks } from "@/lib/db/settlement-sync";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

/** Constant-time compare that tolerates a length mismatch without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on differing lengths, which would itself be an oracle.
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
    return safeErrorResponse(err, "settlement_sync_cron_config_invalid");
  }

  if (!cronSecret) {
    // Fail closed. An unset secret is a misconfiguration, not permission to run.
    log("error", "settlement_sync_cron_secret_not_configured", {});
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET is not configured. Refusing to run an unauthenticated settlement sync.",
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !secretMatches(provided, cronSecret)) {
    // No detail in the response and no secret material in the log line.
    log("warn", "settlement_sync_cron_unauthorized", {
      had_header: header.length > 0,
    });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await syncSettledTasks();

    return NextResponse.json({
      ok: true,
      considered: summary.considered,
      updated: summary.updated.length,
      unchanged: summary.unchanged,
      mismatched: summary.mismatched.length,
      outcome_missing: summary.outcome_missing.length,
      deferred: summary.deferred.length,
      failed: summary.failed.length,
      transitions: summary.updated.map((t) => ({
        payment_request_id: t.payment_request_id,
        from: t.from,
        to: t.to,
      })),
      // Surfaced so a row that never syncs is visible rather than silently
      // retried forever. The error text stays in the server log.
      failures: summary.failed.map((f) => f.payment_request_id),
      mismatches: summary.mismatched,
    });
  } catch (err: unknown) {
    return safeErrorResponse(err, "settlement_sync_cron_failed");
  }
}
