/**
 * dispatch.ts
 * Contractor notification dispatch — the CC-094 seam, now wired to the CC-095
 * delivery engine.
 *
 * History, because it explains the shape: this module was born as the
 * ADR-0005 D7 logging seam — "CC-095 is not built yet, so record the event per
 * channel as a structured log line and nothing more; CC-095 replaces one
 * function and the lifecycle needs no further change." PR #125 then shipped the
 * engine (`src/lib/notifications/delivery.ts`) on 2026-08-22, but the
 * replacement never happened: the lifecycle kept importing this logging stub,
 * and CC-095 was closed on 2026-08-26 against call sites that reached *this*
 * module, not the engine — a closure reopened on 2026-09-16 when it was found
 * that no non-test code had ever imported delivery.ts.
 *
 * So the swap the header planned for CC-095 happens here: `notifyContractor`
 * and `notifyAutoBookingDisabled` now deliver for real over every registered
 * channel, keeping the two promises the lifecycle has always relied on —
 *
 *   • Never throws: a notification failure must never fail the hire, accept,
 *     funding-confirmation or verdict path it rides on. The engine's
 *     notifyContractor throws only on a malformed payload (a programming
 *     error, caught below); delivery faults are contained inside the engine
 *     and reported as failed outcome records.
 *   • Never logs a channel address: notification_channels holds workers'
 *     contact addresses, exactly the third-party data carve-out in the
 *     publish-by-default policy (CC-009, ADR-0002 D9). The engine enforces
 *     this too (maskChannelAddress / sha256 handles), but the promise is
 *     restated here because callers were promised it at the seam.
 *
 * The lifecycle event shapes below are unchanged from the logging era, so no
 * caller had to move; they are translated 1:1 into the engine's payload.
 */

import {
  notifyContractor as deliverToContractor,
  dispatchToChannels,
} from "@/lib/notifications/delivery";
import type { ChannelDeliveryResult } from "@/lib/notifications/types";
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

/**
 * Tell a worker their auto-booking was switched off (CC-075 / ADR-0005 D6,
 * ADR-0001 D1). Real delivery since CC-095's wiring: one attempt series per
 * registered channel, each reported honestly. The caller (awol.ts) already
 * holds the channel list, so the channels are passed in rather than re-read.
 *
 * `category` carries the AWOL signal as the notice's reason — it is the only
 * payload field the engine's schema has for a non-sensitive label, and
 * "lapsed_offers" / "expired_tasks" is exactly that.
 */
export async function notifyAutoBookingDisabled(input: {
  worker: { id: string; wallet: string };
  channels: NotificationChannel[];
  signal: AwolSignal;
}): Promise<DeliveryAttempt[]> {
  if (input.channels.length === 0) {
    return [];
  }

  let results: ChannelDeliveryResult[];
  try {
    results = await dispatchToChannels(
      input.channels,
      "auto_booking_disabled",
      {
        taskId: "auto-booking",
        category: input.signal,
      },
    );
  } catch (err) {
    // A programming error (bad payload shape) rather than a delivery fault.
    // Contained here: the AWOL decision that triggered this notice must stand
    // regardless of the notification's fate.
    log("error", "worker_notice_dispatch_failed", {
      contractor_id: input.worker.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return input.channels.map((channel) => ({
      channel_id: channel.id,
      channel_type: channel.type,
      delivered: false,
    }));
  }

  return results.map((result) => ({
    channel_id: result.channelId,
    channel_type: result.channelType,
    delivered: result.outcome === "delivered",
  }));
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
      /** Reminder that a pending offer is about to lapse (reminder cron). */
      type: "offer_expiring";
      payment_request_id: string;
      amount_usdc: number;
      offer_expiry_unix: number;
    }
  | {
      /** Chain-confirmed funding (fund-task route). Not sent at hire time —
       *  at hire the money is not locked yet, and a "task funded" message
       *  then would be a lie sent at the worker's expense. */
      type: "task_funded";
      payment_request_id: string;
      amount_usdc: number;
      /** Delivery deadline, unix seconds — on the row and on-chain. */
      deadline_unix?: number;
    }
  | {
      /** Verdict computed and signed (either surface). */
      type: "verdict_signed";
      payment_request_id: string;
      passed: boolean;
      amount_usdc?: number;
    }
  | {
      /** Passing verdict → the worker's pull-payment window is open. */
      type: "payment_claimable";
      payment_request_id: string;
      amount_usdc?: number;
    }
  | { type: "task_accepted"; payment_request_id: string }
  | { type: "task_declined"; payment_request_id: string };

export interface NotifyResult {
  /** Channels the event was dispatched to (delivered or visibly failed). */
  notified_channels: number;
}

/**
 * Deliver a lifecycle event to a contractor's registered channels via the
 * CC-095 engine. Fire-and-forget by design — callers need not await a
 * meaningful outcome, and this never rejects. Translation from the lifecycle
 * event shape to the engine payload is total: every field maps, nothing is
 * dropped on the floor.
 */
export async function notifyContractor(
  contractorId: string,
  event: ContractorNotificationEvent,
): Promise<NotifyResult> {
  try {
    let results: ChannelDeliveryResult[];
    switch (event.type) {
      case "offer_received":
        results = await deliverToContractor(contractorId, "offer_received", {
          taskId: event.payment_request_id,
          amountUsdc: event.amount_usdc,
          ...(event.offer_expiry_unix !== null
            ? { offerExpiresAt: event.offer_expiry_unix }
            : {}),
        });
        break;
      case "offer_expiring":
        results = await deliverToContractor(contractorId, "offer_expiring", {
          taskId: event.payment_request_id,
          amountUsdc: event.amount_usdc,
          offerExpiresAt: event.offer_expiry_unix,
        });
        break;
      case "task_funded":
        results = await deliverToContractor(contractorId, "task_funded", {
          taskId: event.payment_request_id,
          amountUsdc: event.amount_usdc,
          ...(event.deadline_unix !== undefined
            ? { deadlineUnix: event.deadline_unix }
            : {}),
        });
        break;
      case "verdict_signed":
        results = await deliverToContractor(contractorId, "verdict_signed", {
          taskId: event.payment_request_id,
          amountUsdc: event.amount_usdc,
          ...(event.passed
            ? { category: "passed" }
            : { category: "failed" }),
        });
        break;
      case "payment_claimable":
        results = await deliverToContractor(contractorId, "payment_claimable", {
          taskId: event.payment_request_id,
          amountUsdc: event.amount_usdc,
        });
        break;
      case "task_accepted":
        results = await deliverToContractor(contractorId, "task_accepted", {
          taskId: event.payment_request_id,
        });
        break;
      case "task_declined":
        results = await deliverToContractor(contractorId, "task_declined", {
          taskId: event.payment_request_id,
        });
        break;
    }

    // The engine logs per-channel outcomes itself; this line is the aggregate
    // the lifecycle path can grep for. Event type only — the payload is task
    // content and must never reach a log line (ADR-0002 D4).
    log("info", "contractor_notification", {
      contractor_id: contractorId,
      event_type: event.type,
      notified_channels: results.length,
      delivered_channels: results.filter((r) => r.outcome === "delivered").length,
    });

    return { notified_channels: results.length };
  } catch {
    // The engine throws only on a malformed payload — a programming error on
    // our side, never a delivery fault (those are contained per-channel and
    // logged at error level by the engine). Either way the lifecycle event
    // that triggered this must succeed regardless.
    return { notified_channels: 0 };
  }
}
