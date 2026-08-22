/**
 * types.ts (CC-095)
 * Shapes for the notification delivery engine.
 *
 * A notification payload is task content by definition (ADR-0002 D4, ADR-0001
 * Amendment 2 A2.1): it names the task and may carry its description. That is fine
 * on the wire — the worker chose the channel — but it is why nothing in this module
 * or its adapters may ever write a payload or a channel address to a log line
 * (CC-009, CC-095). Outcomes travel as structured records, not as serialised bodies.
 */

import { z } from "zod";
import type { NotificationChannelType } from "@/lib/db/types";

/** The lifecycle events worth interrupting a worker for (CC-095 scope). */
export const NOTIFICATION_EVENTS = [
  "offer_received",
  "offer_expiring",
  "task_funded",
  "verdict_signed",
  "payment_claimable",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * What a notification is about. `taskId` is the payment_request_id — the identifier
 * the worker sees on their dashboard, never an internal surrogate that would need a
 * lookup to be actionable. `taskDescription` is optional and deliberately bounded:
 * callers that already show the spec elsewhere can omit it.
 */
export const notificationPayloadSchema = z.object({
  taskId: z.string().min(1),
  amountUsdc: z.number().positive().optional(),
  /** Offer expiry, unix seconds — offer_received / offer_expiring (ADR-0005 D4). */
  offerExpiresAt: z.number().int().positive().optional(),
  /** Delivery deadline, unix seconds — task_funded. */
  deadlineUnix: z.number().int().positive().optional(),
  /** Optional non-sensitive label, e.g. the service category. */
  category: z.string().min(1).optional(),
  taskDescription: z.string().max(2_000).optional(),
});

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

export type DeliveryOutcome = "delivered" | "failed";

/**
 * The outcome of one delivery attempt series against one channel. This record —
 * never the request body — is what gets logged and returned to the caller, so it
 * carries a masked handle for the address rather than the address itself.
 */
export interface ChannelDeliveryResult {
  channelId: string;
  channelType: NotificationChannelType;
  outcome: DeliveryOutcome;
  /** Attempt count, including the first. 1 means no retry was warranted (or made). */
  attempts: number;
  /**
   * Sanitised failure code (`http_500`, `timeout`, `email_transport_unconfigured`).
   * Never an upstream error message: fetch failures embed the destination URL, and a
   * channel address is either a worker's email or a URL with a credential in it.
   */
  error?: string;
  /** sha256-derived handle for the channel address, for correlating log lines. */
  addressMasked: string;
}
