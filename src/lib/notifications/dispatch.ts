/**
 * dispatch.ts
 * The seam where worker-facing notifications leave the app (CC-075).
 *
 * ADR-0005 D7: notification delivery is a dependency of anything that acts
 * on a worker without their involvement. An auto-booking disable nobody is
 * told about is the silent opt-out CC-075 explicitly wanted to avoid.
 *
 * CC-095 owns real delivery transports (email, webhook, telegram, discord).
 * Until it lands, dispatch records each attempt as a structured event and
 * reports the channel as undelivered rather than pretending it was sent —
 * a placeholder that lies is worse than no transport. This module is the
 * single place CC-095 needs to fill in.
 *
 * PII: channel addresses (emails especially — ADR-0002 D9) never reach a log
 * line. Only the channel id and type are recorded.
 */

import type { NotificationChannel } from "@/lib/db/notifications";
import type { AwolSignal } from "@/lib/awol";
import { log } from "@/lib/logging";

export type WorkerNoticeKind = "auto_booking_disabled";

export interface WorkerNotice {
  kind: WorkerNoticeKind;
  contractor_id: string;
  signal: AwolSignal;
  message: string;
}

export interface DispatchAttempt {
  channel_id: string;
  type: NotificationChannel["type"];
  delivered: boolean;
  reason?: string;
}

export const AUTO_BOOKING_DISABLED_MESSAGE =
  "Auto-booking has been switched off because recent offers to you expired without a response. " +
  "Nothing is lost and this is not a penalty — if you're still available, you can re-enable " +
  "auto-booking at any time from your dashboard's notification settings.";

/**
 * Build the CC-075 notice. Kept separate from delivery so the wording is
 * assertable in tests independently of any transport.
 */
export function buildAutoBookingDisabledNotice(input: {
  contractorId: string;
  signal: AwolSignal;
}): WorkerNotice {
  return {
    kind: "auto_booking_disabled",
    contractor_id: input.contractorId,
    signal: input.signal,
    message: AUTO_BOOKING_DISABLED_MESSAGE,
  };
}

/**
 * Deliver one notice to one channel. The transport itself is CC-095's work;
 * this is the honest placeholder.
 */
async function deliverNotice(
  channel: NotificationChannel,
  notice: WorkerNotice,
): Promise<DispatchAttempt> {
  void notice;
  return {
    channel_id: channel.id,
    type: channel.type,
    delivered: false,
    reason: "no delivery transport yet (CC-095)",
  };
}

/**
 * Notify a worker that their auto-booking was disabled for inactivity
 * (CC-075). Out-of-band by design: the hiring agent's response never waits
 * on it. Returns the per-channel attempts so callers can log a summary.
 */
export async function notifyAutoBookingDisabled(input: {
  worker: { id: string; wallet: string };
  channels: NotificationChannel[];
  signal: AwolSignal;
}): Promise<DispatchAttempt[]> {
  const notice = buildAutoBookingDisabledNotice({
    contractorId: input.worker.id,
    signal: input.signal,
  });

  const attempts: DispatchAttempt[] = [];
  for (const channel of input.channels) {
    attempts.push(await deliverNotice(channel, notice));
  }

  log("info", "worker_notice_dispatched", {
    wallet: input.worker.wallet,
    kind: notice.kind,
    signal: notice.signal,
    channels: attempts.length,
    delivered: attempts.filter((a) => a.delivered).length,
  });

  return attempts;
}
