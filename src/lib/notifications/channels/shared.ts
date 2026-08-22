/**
 * shared.ts (CC-095)
 * Pieces every channel adapter uses: the HMAC request signature and the
 * outcome-record constructor.
 */

import { createHmac } from "node:crypto";
import type { NotificationChannel } from "@/lib/db/notifications";
import { getConfig } from "@/lib/config";
import { maskChannelAddress } from "../mask";
import type { HttpResult } from "../http";
import type { ChannelDeliveryResult } from "../types";

/**
 * Timestamp + HMAC headers for webhook-style deliveries, so a receiver can reject
 * replays and forgeries. The signature covers `${timestamp}.${body}` — the
 * timestamp is in the MAC's input, so it cannot be swapped after signing.
 *
 * `NOTIFICATION_WEBHOOK_SECRET` is a single platform-level secret in v1 (the
 * channel registry stores only an address). When unset the timestamp header still
 * travels and the signature header is omitted, rather than signing with a
 * guessable default.
 */
export function signedHeaders(
  body: string,
  secret: string | undefined,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  if (!secret) {
    return { "x-cc-timestamp": timestamp };
  }
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return {
    "x-cc-timestamp": timestamp,
    "x-cc-signature": `sha256=${mac}`,
  };
}

/** Read the shared secret through config, where blank reads as unset (CC-097). */
export function webhookSecret(): string | undefined {
  return getConfig().NOTIFICATION_WEBHOOK_SECRET;
}

/**
 * Fold a (possibly retried) HTTP outcome into the record the caller and the logger
 * see. The channel address appears only as its masked handle.
 */
export function finishResult(
  channel: NotificationChannel,
  result: HttpResult & { attempts: number },
): ChannelDeliveryResult {
  return {
    channelId: channel.id,
    channelType: channel.type,
    outcome: result.ok ? "delivered" : "failed",
    attempts: result.attempts,
    ...(result.ok ? {} : { error: result.error ?? "unknown" }),
    addressMasked: maskChannelAddress(channel.address),
  };
}

/** An outcome for a channel that could not be attempted at all. */
export function unconfiguredResult(
  channel: NotificationChannel,
  error: string,
): ChannelDeliveryResult {
  return {
    channelId: channel.id,
    channelType: channel.type,
    outcome: "failed",
    attempts: 0,
    error,
    addressMasked: maskChannelAddress(channel.address),
  };
}
