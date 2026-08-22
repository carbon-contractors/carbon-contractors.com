/**
 * discord.ts (CC-095)
 * Delivery via a Discord webhook URL. The registered channel address is the full
 * webhook URL — it embeds the credential, so it is masked in every log line and
 * never appears in an error message.
 */

import type { NotificationChannel } from "@/lib/db/notifications";
import { postJson } from "../http";
import { withRetries, type RetryPolicy } from "../retry";
import { clampText, formatMessage } from "../messages";
import type { ChannelDeliveryResult, NotificationEvent, NotificationPayload } from "../types";
import { finishResult } from "./shared";

const DISCORD_MAX = 2_000;

export async function deliverToDiscord(
  channel: NotificationChannel,
  event: NotificationEvent,
  payload: NotificationPayload,
  policy: RetryPolicy,
): Promise<ChannelDeliveryResult> {
  const message = formatMessage(event, payload);
  const body = JSON.stringify({
    content: clampText(`**${message.title}**\n\n${message.body}`, DISCORD_MAX),
  });
  const result = await withRetries(
    () => postJson(channel.address, body, {}, policy.timeoutMs),
    policy,
  );
  return finishResult(channel, result);
}
