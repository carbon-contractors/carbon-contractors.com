/**
 * email.ts (CC-095)
 * Email delivery behind a pluggable transport.
 *
 * There is no mail provider in the stack today, and adding one is the first
 * third-party data processor in the architecture — CC-095's open item, which needs
 * an ADR-0002 read before a provider is chosen. So the default transport is a
 * signed JSON POST to `NOTIFICATION_EMAIL_WEBHOOK_URL` (an operator-configured
 * gateway, e.g. an own-domain relay), and `setEmailTransport` lets a future
 * provider adapter slot in without touching the dispatch layer.
 *
 * With no gateway configured, email delivery is a permanent, *visible* failure —
 * not a silent skip: a worker with an email channel registered has asked to be
 * reached there.
 */

import type { NotificationChannel } from "@/lib/db/notifications";
import { getConfig } from "@/lib/config";
import { postJson, type HttpResult } from "../http";
import { withRetries, type RetryPolicy } from "../retry";
import { formatMessage } from "../messages";
import type { ChannelDeliveryResult, NotificationEvent, NotificationPayload } from "../types";
import { finishResult, signedHeaders, webhookSecret } from "./shared";

export interface EmailInput {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  send(input: EmailInput): Promise<HttpResult>;
}

/** Test/future-provider seam. Pass null to fall back to the default transport. */
export function setEmailTransport(transport: EmailTransport | null): void {
  customTransport = transport;
}

let customTransport: EmailTransport | null = null;

function defaultTransport(policy: RetryPolicy): EmailTransport {
  return {
    async send({ to, subject, text }): Promise<HttpResult> {
      const gatewayUrl = getConfig().NOTIFICATION_EMAIL_WEBHOOK_URL;
      if (!gatewayUrl) {
        return { ok: false, transient: false, error: "email_transport_unconfigured" };
      }
      // The gateway needs the address on the wire; it must still never reach a log.
      const body = JSON.stringify({ to, subject, text });
      return postJson(
        gatewayUrl,
        body,
        signedHeaders(body, webhookSecret()),
        policy.timeoutMs,
      );
    },
  };
}

export async function deliverToEmail(
  channel: NotificationChannel,
  event: NotificationEvent,
  payload: NotificationPayload,
  policy: RetryPolicy,
): Promise<ChannelDeliveryResult> {
  const message = formatMessage(event, payload);
  const transport = customTransport ?? defaultTransport(policy);
  const result = await withRetries(
    () =>
      transport.send({
        to: channel.address,
        subject: `[Carbon Contractors] ${message.title}`,
        text: message.body,
      }),
    policy,
  );
  return finishResult(channel, result);
}
