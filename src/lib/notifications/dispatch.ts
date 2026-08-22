/**
 * dispatch.ts
 * Contractor notification dispatch — the seam CC-095 plugs real delivery into.
 *
 * ADR-0005 D7 makes notification delivery a dependency of the offer lifecycle,
 * not a nicety: an offer nobody is told about is an expiry with extra steps.
 * CC-095 (delivery over email/webhook/telegram/discord) is not built yet, so
 * this module records the event per channel as a structured log line and
 * nothing more. Every offer-path caller goes through `notifyContractor`, so
 * CC-095 replaces one function and the lifecycle needs no further change.
 *
 * Never throws: a notification failure must never fail the hire or accept
 * path it rides on. And never log a channel address — notification_channels
 * holds workers' contact addresses, which is exactly the third-party data
 * carve-out in the publish-by-default policy (CC-009, ADR-0002 D9).
 */

import { getChannelsForContractor } from "@/lib/db/notifications";
import type { NotificationChannel } from "@/lib/db/notifications";
import type { AwolSignal } from "@/lib/awol";
import { log } from "@/lib/logging";

export const AUTO_BOOKING_DISABLED_MESSAGE =
  "Auto-booking was automatically disabled for inactivity (consecutive lapsed offers or expired tasks). You can re-enable it anytime from your dashboard.";

export interface AutoBookingDisabledNotice {
  kind: "auto_booking_disabled";
  signal: AwolSignal;
  contractorId: string;
  message: string;
}

export function buildAutoBookingDisabledNotice(input: {
  contractorId: string;
  signal: AwolSignal;
}): AutoBookingDisabledNotice {
  return {
    kind: "auto_booking_disabled",
    signal: input.signal,
    contractorId: input.contractorId,
    message: AUTO_BOOKING_DISABLED_MESSAGE,
  };
}

export interface DeliveryAttempt {
  channel_id: string;
  channel_type: string;
  delivered: boolean;
}

export async function notifyAutoBookingDisabled(input: {
  worker: { id: string; wallet: string };
  channels: NotificationChannel[];
  signal: AwolSignal;
}): Promise<DeliveryAttempt[]> {
  const notice = buildAutoBookingDisabledNotice({
    contractorId: input.worker.id,
    signal: input.signal,
  });

  const attempts: DeliveryAttempt[] = [];

  for (const channel of input.channels) {
    log("info", "worker_notice_dispatched", {
      contractor_id: input.worker.id,
      channel_id: channel.id,
      channel_type: channel.type,
      kind: notice.kind,
      signal: notice.signal,
    });
    // Delivered is false until CC-095 lands real channel delivery
    attempts.push({
      channel_id: channel.id,
      channel_type: channel.type,
      delivered: false,
    });
  }

  return attempts;
}

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
    // Delivery (and its observability) is CC-095's problem. The lifecycle
    // event that triggered this must succeed regardless.
    return { notified_channels: 0 };
  }
}
