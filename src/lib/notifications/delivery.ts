/**
 * delivery.ts (CC-095)
 * High-level notification dispatch: resolve the contractor, load their registered
 * channels, deliver to all of them in parallel.
 *
 * Design constraints, from the ticket and ADR-0005 D7:
 *
 *   • Inline execution — no durable outbox. A notification payload containing task
 *     content is task content (ADR-0002 D4), so a queue that outlived the task row
 *     would falsify the retention claim via the back door. Outcomes are returned to
 *     the caller and logged; nothing is persisted here.
 *   • Parallel dispatch — a slow webhook must not delay the Telegram ping.
 *   • Contained failure — a channel that throws or 500s its way through the retry
 *     budget is reported as a failed outcome, never allowed to reject the caller's
 *     promise. A notification is a side-effect of the money path, not part of it.
 *   • Visible permanence — an exhausted retry is logged at error level (ADR-0003's
 *     "alert on absence" reasoning applied to delivery).
 *   • No PII in logs — channel addresses only ever appear as masked handles, and
 *     payloads/task descriptions never appear at all (CC-009, CC-095).
 */

import {
  getChannelsForContractor,
  type NotificationChannel,
} from "@/lib/db/notifications";
import { getHumanById, getHumanByWallet } from "@/lib/db/whitepages";
import { log, maskWallet } from "@/lib/logging";
import { deliverToDiscord } from "./channels/discord";
import { deliverToEmail } from "./channels/email";
import { deliverToTelegram } from "./channels/telegram";
import { deliverToWebhook } from "./channels/webhook";
import { resolvePolicy, type RetryPolicy } from "./retry";
import {
  notificationPayloadSchema,
  type ChannelDeliveryResult,
  type NotificationEvent,
  type NotificationPayload,
} from "./types";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** One channel, one attempt series. Never rejects — see the header note. */
async function deliverToChannel(
  channel: NotificationChannel,
  event: NotificationEvent,
  payload: NotificationPayload,
  policy: RetryPolicy,
): Promise<ChannelDeliveryResult> {
  try {
    switch (channel.type) {
      case "email":
        return await deliverToEmail(channel, event, payload, policy);
      case "webhook":
        return await deliverToWebhook(channel, event, payload, policy);
      case "telegram":
        return await deliverToTelegram(channel, event, payload, policy);
      case "discord":
        return await deliverToDiscord(channel, event, payload, policy);
    }
  } catch (err) {
    // The adapters are not supposed to throw. If one does anyway, a reject here
    // would take down the caller's request for the sake of a notification.
    // Contain it, and make it visible without echoing any upstream message.
    log("error", "notification_delivery_exception", {
      notification_event: event,
      channel_id: channel.id,
      channel_type: channel.type,
      error: err instanceof Error ? err.name : "unknown",
    });
    return {
      channelId: channel.id,
      channelType: channel.type,
      outcome: "failed",
      attempts: 0,
      error: "delivery_exception",
      addressMasked: "",
    };
  }
}

function logOutcome(event: NotificationEvent, result: ChannelDeliveryResult): void {
  const level = result.outcome === "delivered" ? "info" : "error";
  log(level, "notification_delivery_result", {
    notification_event: event,
    channel_id: result.channelId,
    channel_type: result.channelType,
    outcome: result.outcome,
    attempts: result.attempts,
    ...(result.error ? { error: result.error } : {}),
    ...(result.addressMasked ? { channel_address_masked: result.addressMasked } : {}),
  });
}

/**
 * Deliver `event` to every channel in `channels`, in parallel.
 * Each channel's outcome (delivered after retries, or failed visibly) is returned.
 */
export async function dispatchToChannels(
  channels: NotificationChannel[],
  event: NotificationEvent,
  payload: NotificationPayload,
  policy?: Partial<RetryPolicy>,
): Promise<ChannelDeliveryResult[]> {
  const resolved = resolvePolicy(policy);
  const results = await Promise.all(
    channels.map((channel) => deliverToChannel(channel, event, payload, resolved)),
  );
  for (const result of results) {
    logOutcome(event, result);
  }
  return results;
}

/**
 * Resolve a contractor by wallet address or UUID, load their registered
 * notification channels, and dispatch `event` to all of them in parallel.
 *
 * Returns one outcome record per channel — empty when the contractor is unknown or
 * has no channels, which is a normal state (a worker who never registered), not an
 * error. DB faults are logged and also return empty: notification must never be
 * the reason a money-path request fails.
 */
export async function notifyContractor(
  contractorWalletOrId: string,
  event: NotificationEvent,
  payload: NotificationPayload,
  policy?: Partial<RetryPolicy>,
): Promise<ChannelDeliveryResult[]> {
  // Internal callers construct the payload, but validate at the boundary anyway —
  // a malformed payload travelling into signed webhook bodies is worth a loud
  // failure now rather than a worker-side mystery later.
  const parsed = notificationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `notifyContractor: invalid payload: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const isWallet = WALLET_RE.test(contractorWalletOrId);
  // Wallets are lowercase in the DB and enforced by CHECK (migration 014), so a
  // mixed-case lookup silently misses rather than erroring — normalise both sides.
  const contractorLabel = isWallet
    ? maskWallet(contractorWalletOrId.toLowerCase())
    : contractorWalletOrId;

  let contractorId: string | null = null;
  try {
    contractorId = isWallet
      ? (await getHumanByWallet(contractorWalletOrId.toLowerCase()))?.id ?? null
      : (await getHumanById(contractorWalletOrId))?.id ?? null;
  } catch (err) {
    log("error", "notification_contractor_lookup_failed", {
      notification_event: event,
      contractor: contractorLabel,
      error: err instanceof Error ? err.name : "unknown",
    });
    return [];
  }

  if (!contractorId) {
    log("warn", "notification_contractor_not_found", {
      notification_event: event,
      contractor: contractorLabel,
    });
    return [];
  }

  let channels: NotificationChannel[];
  try {
    channels = await getChannelsForContractor(contractorId);
  } catch (err) {
    log("error", "notification_channel_load_failed", {
      notification_event: event,
      contractor: contractorLabel,
      error: err instanceof Error ? err.name : "unknown",
    });
    return [];
  }

  if (channels.length === 0) {
    // NOTE: the meta key is `notification_event`, not `event` — log() spreads meta
    // after its own `event` field, so a meta key of that name would clobber the
    // log event itself (found by the CC-095 tests, not by reading).
    log("info", "notification_no_channels", {
      notification_event: event,
      contractor: contractorLabel,
    });
    return [];
  }

  return dispatchToChannels(channels, event, parsed.data, policy);
}
