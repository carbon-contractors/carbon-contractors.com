/**
 * telegram.ts (CC-095)
 * Delivery via the Telegram Bot API sendMessage. The registered channel address is
 * the chat id; the bot token is platform-level config (`TELEGRAM_BOT_TOKEN`).
 *
 * Text is sent without a parse_mode: task descriptions are arbitrary worker/agent
 * input, and Markdown/HTML modes would let a description break rendering or inject
 * markup into the message.
 */

import type { NotificationChannel } from "@/lib/db/notifications";
import { getConfig } from "@/lib/config";
import { postJson } from "../http";
import { withRetries, type RetryPolicy } from "../retry";
import { clampText, formatMessage } from "../messages";
import type { ChannelDeliveryResult, NotificationEvent, NotificationPayload } from "../types";
import { finishResult, unconfiguredResult } from "./shared";

const TELEGRAM_MAX = 4_096;

export async function deliverToTelegram(
  channel: NotificationChannel,
  event: NotificationEvent,
  payload: NotificationPayload,
  policy: RetryPolicy,
): Promise<ChannelDeliveryResult> {
  const token = getConfig().TELEGRAM_BOT_TOKEN;
  // Unconfigured is a permanent, visible failure — not a silent skip. A worker with
  // a Telegram channel registered is expecting the ping (CC-095 acceptance).
  if (!token) {
    return unconfiguredResult(channel, "telegram_unconfigured");
  }

  const message = formatMessage(event, payload);
  const body = JSON.stringify({
    chat_id: channel.address,
    text: clampText(`${message.title}\n\n${message.body}`, TELEGRAM_MAX),
  });
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const result = await withRetries(
    () => postJson(url, body, {}, policy.timeoutMs),
    policy,
  );
  return finishResult(channel, result);
}
