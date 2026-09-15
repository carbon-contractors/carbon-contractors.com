/**
 * route.ts — GET /api/cron/offer-reminders (CC-095)
 *
 * The scheduler for the offer_expiring event — the one CC-095 event with no
 * synchronous moment to ride on. An offer sits pending until the worker
 * answers or it lapses; "about to expire" is a property of the clock, not of
 * any request, so it needs a scan.
 *
 * Hourly. The reminder lead (OFFER_REMINDER_LEAD_SECONDS, 2h) is above this
 * interval, so every offer whose expiry is more than the lead away when it is
 * created is guaranteed to be seen by at least one scan inside its reminder
 * window — the scan cannot skip past a reminder-worthy offer.
 *
 * ## Exactly once per offer
 *
 * Migration 024's offer_reminder_sent marker, set by compare-and-set
 * (markOfferReminderSent) BEFORE dispatch: overlapping cron runs race, and the
 * loser sees zero rows updated and skips. The ordering also means a crash after
 * the marker write but before dispatch loses the reminder — the honest failure,
 * and the right one to bias toward: notification is best-effort, but a nag
 * loop that re-fires hourly on a dead channel is worse than one lost reminder.
 *
 * ## Same fail-closed posture as the retention/backup crons
 *
 * CRON_SECRET — unset (or blank) means refuse, not run. The route needs the
 * service-role key (channel registry + whitepages reads), which lives only in
 * Vercel's environment; see the retention route's PR #147 argument for why
 * this runs where the credential already is.
 *
 * ## What it logs
 *
 * Counts only, plus masked wallet handles. No task content, no channel
 * addresses (ADR-0002 D4/D9, CC-009) — the notifyContractor seam enforces the
 * same on the delivery side.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  getOffersNeedingReminder,
  markOfferReminderSent,
} from "@/lib/db/tasks";
import { notifyContractor } from "@/lib/notifications/dispatch";
import { getHumanByWallet } from "@/lib/db/whitepages";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";
import { safeErrorResponse } from "@/lib/errors";

/** Constant-time compare that tolerates a length mismatch without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) {
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
    return safeErrorResponse(err, "offer_reminder_cron_config_invalid");
  }

  if (!cronSecret) {
    log("error", "offer_reminder_cron_secret_not_configured", {});
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET is not configured. Refusing to run an unauthenticated reminder scan.",
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !secretMatches(provided, cronSecret)) {
    log("warn", "offer_reminder_cron_unauthorized", {
      had_header: header.length > 0,
    });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);

  let candidates;
  try {
    candidates = await getOffersNeedingReminder(now);
  } catch (err) {
    return safeErrorResponse(err, "offer_reminder_scan_failed");
  }

  let dispatched = 0;
  let skippedRace = 0;
  let noWorker = 0;

  for (const offer of candidates) {
    // Claim first: the compare-and-set on status+marker decides this run's
    // right to send. A concurrent winner means skip, not error.
    let claimed: boolean;
    try {
      claimed = await markOfferReminderSent(offer.payment_request_id);
    } catch {
      claimed = false;
    }
    if (!claimed) {
      skippedRace++;
      continue;
    }

    // The claim is spent; a lookup or dispatch fault from here must not
    // abort the remaining offers. Counted and logged, never thrown.
    let workerId: string | null = null;
    try {
      workerId = (await getHumanByWallet(offer.to_human_wallet))?.id ?? null;
    } catch {
      workerId = null;
    }
    if (!workerId) {
      noWorker++;
      continue;
    }

    try {
      await notifyContractor(workerId, {
        type: "offer_expiring",
        payment_request_id: offer.payment_request_id,
        amount_usdc: offer.amount_usdc,
        offer_expiry_unix: offer.offer_expiry_unix,
      });
      dispatched++;
    } catch {
      // The seam never throws; this guards the loop, not the seam.
    }
  }

  log("info", "offer_reminders_run", {
    candidates: candidates.length,
    dispatched,
    skipped_race: skippedRace,
    no_worker: noWorker,
  });

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    dispatched,
    skipped_race: skippedRace,
    no_worker: noWorker,
  });
}
