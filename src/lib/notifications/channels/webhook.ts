/**
 * webhook.ts (CC-095)
 * Delivery to a worker-registered generic webhook: signed JSON POST of the full
 * event envelope. Sent through the CC-108 guard: public addresses only, checked
 * at connect time, no redirects.
 */

import type { NotificationChannel } from "@/lib/db/notifications";
import { postJsonToWebhook } from "../webhook-target";
import { withRetries, type RetryPolicy } from "../retry";
import { buildEnvelope } from "../messages";
import type { ChannelDeliveryResult, NotificationEvent, NotificationPayload } from "../types";
import { finishResult, signedHeaders, webhookSecret } from "./shared";

export async function deliverToWebhook(
  channel: NotificationChannel,
  event: NotificationEvent,
  payload: NotificationPayload,
  policy: RetryPolicy,
): Promise<ChannelDeliveryResult> {
  const body = JSON.stringify(buildEnvelope(event, payload));
  const headers = signedHeaders(body, webhookSecret());
  const result = await withRetries(
    () => postJsonToWebhook(channel.address, body, headers, policy.timeoutMs),
    policy,
  );
  return finishResult(channel, result);
}
