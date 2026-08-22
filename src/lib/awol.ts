/**
 * awol.ts
 * CC-075 — auto-disable `accepts_auto_booking` when a worker goes AWOL.
 *
 * Two signals, one nested inside the other:
 *
 *   Primary  — N consecutive **lapsed offers** (ADR-0005 D6). A worker who is
 *              silent until offers lapse is AWOL, and that is observable
 *              before anyone commits money: no escrow, no chain, no gas.
 *   Backstop — N consecutive **expired tasks with zero work submitted**
 *              (ADR-0001 D1). Catches a different worker — the one who
 *              *accepts* and then vanishes, which lapsed offers cannot see
 *              by definition.
 *
 * Both are evaluated **inline at auto-booking time**, not on a cron — a
 * scheduled job maintaining a flag that is only ever read at booking is
 * pure overhead. The action is reversible by design and is explicitly not
 * a slash and not a reputation penalty: an expiry refunded the agent, so
 * nobody lost anything, and the legitimate-leave false positive costs the
 * worker one toggle on their dashboard.
 *
 * Declining is participation, never silence (ADR-0005 D6) — a decline does
 * not count towards either streak and resets both.
 */

import { getChannelsForContractor, setAcceptsAutoBookingForContractor } from "@/lib/db/notifications";
import { getTasksByWallet } from "@/lib/db/tasks";
import { notifyAutoBookingDisabled } from "@/lib/notifications/dispatch";
import { log } from "@/lib/logging";

/** Consecutive lapsed offers before auto-booking switches off (ADR-0005 D6). */
export const AWOL_LAPSED_OFFER_THRESHOLD = 3;
/** Consecutive expired-without-submission tasks before auto-booking switches off (ADR-0001 D1). */
export const AWOL_EXPIRED_TASK_THRESHOLD = 3;

export type AwolSignal = "lapsed_offers" | "expired_tasks";

/**
 * The lifecycle outcome of one finished (or in-flight) item in a worker's
 * history, reduced to what AWOL detection cares about.
 *
 * `lapsed_offer` and `declined` map from the offer statuses CC-094 will add;
 * until that migration lands the primary signal reads zero and the backstop
 * carries detection alone.
 */
export type AwolOutcome =
  | "lapsed_offer" // offer expired with no worker response — silence (primary)
  | "expired_no_submission" // task expired, no work submitted — silence (backstop)
  | "declined" // participation — resets both streaks (ADR-0005 D6)
  | "accepted" // participation — resets
  | "delivered" // success — resets
  | "completed" // success — resets
  | "disputed" // worker submitted work — participation, resets
  | "other"; // pending/active/in-flight — carries no signal either way

export interface AwolStreaks {
  consecutiveLapsedOffers: number;
  consecutiveExpiredTasks: number;
}

export type AwolVerdict =
  | { triggered: false; signal: null }
  | { triggered: true; signal: AwolSignal };

/**
 * Map a task row's status to an AWOL outcome. Takes the status as a plain
 * string so CC-094's `lapsed`/`accepted`/`declined` statuses are already
 * wired when their migration lands — extend the switch there, not here.
 */
export function taskStatusToAwolOutcome(status: string): AwolOutcome {
  switch (status) {
    case "expired":
      // v2's Expired state is unreachable once work is submitted (ADR-0001 D1),
      // so an expired task is a no-submission expiry.
      return "expired_no_submission";
    case "completed":
      return "completed";
    case "disputed":
      return "disputed";
    case "lapsed":
      return "lapsed_offer";
    case "declined":
      return "declined";
    case "accepted":
      return "accepted";
    default:
      // pending, active — in flight, neither silence nor participation yet
      return "other";
  }
}

/**
 * Count the trailing consecutive silence streaks in a worker's history.
 *
 * Outcomes are chronological, oldest first. In-flight items (`other`) are
 * skipped — an auto-booked task sitting `active` is not evidence of anything.
 * The most recent meaningful outcome decides which streak is being counted;
 * any success or participation outcome (delivery, completion, acceptance,
 * dispute, decline) ends the run and leaves both streaks at zero.
 */
export function computeAwolStreaks(outcomes: AwolOutcome[]): AwolStreaks {
  let kind: "lapsed_offer" | "expired_no_submission" | null = null;
  let run = 0;

  for (let i = outcomes.length - 1; i >= 0; i--) {
    const outcome = outcomes[i];
    if (outcome === "other") continue;
    if (outcome !== "lapsed_offer" && outcome !== "expired_no_submission") {
      break; // success or participation — the streak is over
    }
    if (kind === null) {
      kind = outcome;
      run = 1;
    } else if (kind === outcome) {
      run++;
    } else {
      break; // a different kind of silence starts a fresh streak
    }
  }

  return kind === "lapsed_offer"
    ? { consecutiveLapsedOffers: run, consecutiveExpiredTasks: 0 }
    : kind === "expired_no_submission"
      ? { consecutiveLapsedOffers: 0, consecutiveExpiredTasks: run }
      : { consecutiveLapsedOffers: 0, consecutiveExpiredTasks: 0 };
}

/**
 * Decide whether the streaks cross either threshold. The primary signal is
 * checked first: it is the cheaper one for everyone and the one that fires
 * earlier in a worker's decline.
 */
export function evaluateAwol(streaks: AwolStreaks): AwolVerdict {
  if (streaks.consecutiveLapsedOffers >= AWOL_LAPSED_OFFER_THRESHOLD) {
    return { triggered: true, signal: "lapsed_offers" };
  }
  if (streaks.consecutiveExpiredTasks >= AWOL_EXPIRED_TASK_THRESHOLD) {
    return { triggered: true, signal: "expired_tasks" };
  }
  return { triggered: false, signal: null };
}

export interface AwolBookingDecision {
  /** False when the worker has no auto-bookable channel — nothing to check. */
  evaluated: boolean;
  triggered: boolean;
  signal: AwolSignal | null;
  consecutiveLapsedOffers: number;
  consecutiveExpiredTasks: number;
}

/**
 * The inline auto-booking-time check (CC-075). Call this before treating a
 * hire as auto-accepted. When the worker crosses either AWOL threshold it:
 *
 *   1. flips `accepts_auto_booking` false across all their channels,
 *   2. emits `worker_awol_auto_disabled`,
 *   3. dispatches an out-of-band notification telling them auto-booking was
 *      disabled for inactivity and how to re-enable it, and
 *   4. leaves the current offer as manual acceptance (`pending`).
 *
 * Notification failure is logged, never thrown — a broken dispatch path must
 * not block the disable itself or the hire.
 */
export async function evaluateAwolAtBooking(worker: {
  id: string;
  wallet: string;
}): Promise<AwolBookingDecision> {
  const channels = await getChannelsForContractor(worker.id);
  if (!channels.some((c) => c.accepts_auto_booking)) {
    // Manual acceptance is already the posture; there is no auto-booking to
    // disable and no signal worth reading.
    return {
      evaluated: false,
      triggered: false,
      signal: null,
      consecutiveLapsedOffers: 0,
      consecutiveExpiredTasks: 0,
    };
  }

  // getTasksByWallet orders newest-first; the streaks run oldest→newest.
  const tasks = await getTasksByWallet(worker.wallet);
  const outcomes = [...tasks]
    .reverse()
    .map((t) => taskStatusToAwolOutcome(t.status));
  const streaks = computeAwolStreaks(outcomes);
  const verdict = evaluateAwol(streaks);

  if (!verdict.triggered) {
    return {
      evaluated: true,
      triggered: false,
      signal: null,
      ...streaks,
    };
  }

  const channelsDisabled = await setAcceptsAutoBookingForContractor(
    worker.id,
    false,
  );

  log("warn", "worker_awol_auto_disabled", {
    wallet: worker.wallet,
    signal: verdict.signal,
    consecutive_lapsed_offers: streaks.consecutiveLapsedOffers,
    consecutive_expired_tasks: streaks.consecutiveExpiredTasks,
    channels_disabled: channelsDisabled,
  });

  try {
    await notifyAutoBookingDisabled({ worker, channels, signal: verdict.signal });
  } catch (err) {
    log("warn", "worker_awol_notification_failed", {
      wallet: worker.wallet,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    evaluated: true,
    triggered: true,
    signal: verdict.signal,
    ...streaks,
  };
}
