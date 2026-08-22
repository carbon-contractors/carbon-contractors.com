/**
 * messages.ts (CC-095)
 * Event → message rendering, shared by every channel adapter.
 *
 * Two shapes come out of here:
 *   • `formatMessage` — short title + body for chat-style channels (Telegram,
 *     Discord) and the email subject/body.
 *   • `buildEnvelope` — the structured JSON a webhook receiver (or email gateway)
 *     can consume programmatically.
 *
 * Both include task content when the caller supplied it — that is the point of the
 * notification, and nothing here is persisted (no outbox; the payload dies with the
 * in-flight delivery, per CC-095's retention scope). The constraint is logs, not
 * the wire: nothing in this module logs at all.
 */

import type { NotificationEvent, NotificationPayload } from "./types";

/** Deterministic rendering of unix seconds — no locale, no server timezone. */
function iso(unix?: number): string | null {
  return unix === undefined ? null : new Date(unix * 1000).toISOString();
}

function amountClause(payload: NotificationPayload): string {
  return payload.amountUsdc === undefined
    ? ""
    : ` for ${payload.amountUsdc} USDC`;
}

function descriptionLine(payload: NotificationPayload): string {
  return payload.taskDescription === undefined
    ? ""
    : `\n\nTask: ${payload.taskDescription}`;
}

export interface FormattedMessage {
  title: string;
  body: string;
}

export function formatMessage(
  event: NotificationEvent,
  payload: NotificationPayload,
): FormattedMessage {
  const id = payload.taskId;
  switch (event) {
    case "offer_received":
      return {
        title: "New task offer",
        body:
          `You have been offered a task${amountClause(payload)}. ` +
          `The offer expires ${iso(payload.offerExpiresAt) ?? "(no expiry set)"} — ` +
          `review and accept it on your Carbon Contractors dashboard.` +
          descriptionLine(payload),
      };
    case "offer_expiring":
      return {
        title: "Task offer expiring soon",
        body:
          `Your offer for task (${id}) expires ` +
          `${iso(payload.offerExpiresAt) ?? "shortly"}. ` +
          `Accept it before then if you still want it; otherwise it lapses and the agent re-targets.`,
      };
    case "task_funded":
      return {
        title: "Task funded",
        body:
          `Task (${id}) is now funded and active${amountClause(payload)}. ` +
          `Delivery deadline: ${iso(payload.deadlineUnix) ?? "(not set)"}.` +
          descriptionLine(payload),
      };
    case "verdict_signed":
      return {
        title: "Verdict signed",
        body:
          `A signed verdict has been recorded for task (${id})${amountClause(payload)}. ` +
          `See your dashboard for the outcome.`,
      };
    case "payment_claimable":
      return {
        title: "Payment claimable",
        body:
          `Payment${amountClause(payload)} for task (${id}) is claimable. ` +
          `Settlement is pull-payment — claim it from your dashboard before the funds sit unclaimed.`,
      };
  }
}

/**
 * Structured payload for webhook receivers and the email gateway. Versioned so a
 * receiver can distinguish shapes if this ever grows fields.
 */
export function buildEnvelope(
  event: NotificationEvent,
  payload: NotificationPayload,
): Record<string, unknown> {
  const message = formatMessage(event, payload);
  return {
    version: 1,
    event,
    task_id: payload.taskId,
    amount_usdc: payload.amountUsdc ?? null,
    offer_expires_at: iso(payload.offerExpiresAt),
    deadline_at: iso(payload.deadlineUnix),
    category: payload.category ?? null,
    task_description: payload.taskDescription ?? null,
    message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Clamp rendered text to a channel's length limit (Telegram 4096, Discord 2000).
 * A long task description must not turn the whole notification into a 400.
 */
export function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
