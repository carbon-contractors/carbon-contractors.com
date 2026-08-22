/**
 * dispatch.ts
 * Contractor notification dispatch — the seam CC-095 plugs real delivery into.
 *
 * ADR-0005 D7: notification delivery is a dependency of anything that acts
 * on a worker without their involvement.
 */

import { getChannelsForContractor } from "@/lib/db/notifications";
import type { NotificationChannel } from "@/lib/db/notifications";
import type { AwolSignal } from "@/lib/awol";
import { log } from "@/lib/logging";

export type ContractorNotificationEvent =
  | {
      type: "offer_received";
      payment_request_id: string;
      amount_usdc: number;
      /** Null on auto-accepted rows — there was no window to answer within. */
      offer_expiry_unix: number | null;
    }
  | {
      /** Auto-booked (ADR-0005 D3): consent came from the worker's own flag. */
      type: "task_funded";
      payment_request_id: string;
      amount_usdc: number;
    }
  | { type: "task_accepted"; payment_request_id: string }
  | { type: "task_declined"; payment_request_id: string };

export interface NotifyResult {
  /** Channels the event was recorded against. */
  notified_channels: number;
}

/**
 * Record a lifecycle event against every one of a contractor's registered
 * channels. Fire-and-forget by design — callers need not await a meaningful
 * outcome, and this never rejects.
 */
export async function notifyContractor(
  contractorId: string,
  event: ContractorNotificationEvent,
): Promise<NotifyResult> {
  try {
    const channels = await getChannelsForContractor(contractorId);

    for (const channel of channels) {
      // Channel id and type only — never the address (ADR-0002 D9).
      log("info", "contractor_notification", {
        contractor_id: contractorId,
        channel_id: channel.id,
        channel_type: channel.type,
        event,
      });
    }

    return { notified_channels: channels.length };
  } catch {
    return { notified_channels: 0 };
  }
}

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
