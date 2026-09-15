/**
 * offers.ts
 * Worker decision on a pending offer — accept or decline (CC-094 / ADR-0005).
 *
 * The offer sits in the gap between request_human_work ('pending' row) and
 * createTask (locked USDC), entirely off-chain (ADR-0005 D2). Declining is
 * free and carries no reputational penalty in v1 (D6). Both decisions require
 * wallet-signature authentication at the route; this module assumes the caller
 * has already verified `callerWallet`.
 */

import {
  getTaskByPaymentId,
  updateTaskStatus,
  acceptTask,
  countCommittedTasks,
  lapseExpiredOffers,
  WORKER_CONCURRENCY_CAP,
} from "@/lib/db/tasks";
import { getHumanByWallet } from "@/lib/db/whitepages";
import { notifyContractor } from "@/lib/notifications/dispatch";
import { log } from "@/lib/logging";

export type OfferDecision = "accept" | "decline";

export type OfferResponse =
  | { ok: true; payment_request_id: string; status: "accepted" | "declined" }
  | {
      ok: false;
      /** HTTP status the route should return. */
      httpStatus: number;
      error: string;
      /** Present on 410 — the offer is gone and the agent may re-target. */
      offer_lapsed?: boolean;
      /** Present on the concurrency-cap 409. */
      concurrency_cap?: number;
      committed_tasks?: number;
      /** Present on the brief-changed 409 (CC-084 criterion 5). */
      brief_changed?: boolean;
    };

/**
 * Record the worker's decision on a pending offer.
 *
 * Evaluation order matters: the offer is lapsed inline first (getTaskByPaymentId
 * calls lapseExpiredOffers), so an expired offer reads 'lapsed' here and can
 * never be accepted out of time — even if the worker's request raced the clock.
 */
export async function respondToOffer(
  callerWallet: string,
  paymentRequestId: string,
  decision: OfferDecision,
): Promise<OfferResponse> {
  // Belt and braces: getTaskByPaymentId already lapses inline, but the
  // stale-read window between route auth and here costs nothing to close.
  await lapseExpiredOffers();

  const task = await getTaskByPaymentId(paymentRequestId);
  if (!task) {
    return { ok: false, httpStatus: 404, error: "Task not found" };
  }

  if (task.to_human_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    log("warn", "offer_decision_unauthorized", {
      payment_request_id: paymentRequestId,
      caller: callerWallet,
      assigned_worker: task.to_human_wallet,
    });
    return {
      ok: false,
      httpStatus: 403,
      error: "Not authorized. Only the offered worker may respond to this offer.",
    };
  }

  if (task.status === "lapsed") {
    return {
      ok: false,
      httpStatus: 410,
      error: "This offer has lapsed — its expiry passed without an answer.",
      offer_lapsed: true,
    };
  }

  if (task.status !== "pending") {
    return {
      ok: false,
      httpStatus: 409,
      error: `Task is ${task.status}, not an open offer`,
    };
  }

  // Guard the transition against a mid-flight lapse: updateTaskStatus is
  // atomic on the source status, so a lapsed race fails loudly here rather
  // than silently accepting a dead offer.
  if (
    task.offer_expiry_unix !== null &&
    task.offer_expiry_unix <= Math.floor(Date.now() / 1000)
  ) {
    await updateTaskStatus(paymentRequestId, "lapsed");
    return {
      ok: false,
      httpStatus: 410,
      error: "This offer has lapsed — its expiry passed without an answer.",
      offer_lapsed: true,
    };
  }

  if (decision === "accept") {
    // ADR-0005 D5: the cap on accepted+active tasks per worker. Structural,
    // not advisory — it prevents a self-inflicted cascade of missed deadlines,
    // each of which is an ADR-0001 D1 expiry.
    const committed = await countCommittedTasks(task.to_human_wallet);
    if (committed >= WORKER_CONCURRENCY_CAP) {
      log("warn", "offer_accept_at_concurrency_cap", {
        payment_request_id: paymentRequestId,
        worker: task.to_human_wallet,
        committed,
      });
      return {
        ok: false,
        httpStatus: 409,
        error: `You are at your concurrency cap of ${WORKER_CONCURRENCY_CAP} accepted+active tasks. Complete or let one lapse before accepting another.`,
        concurrency_cap: WORKER_CONCURRENCY_CAP,
        committed_tasks: committed,
      };
    }

    // CC-084 criterion 5: pin the prose the worker is accepting. acceptTask
    // writes the pin and the status flip in one statement, guarded on the
    // description the worker read — so an agent edit that raced their decision
    // surfaces here as a 409 rather than pinning text they never saw.
    const accepted = await acceptTask(
      paymentRequestId,
      task.task_description,
    );
    if (!accepted.ok) {
      if (accepted.reason === "brief_changed") {
        log("warn", "offer_accept_brief_changed", {
          payment_request_id: paymentRequestId,
          worker: task.to_human_wallet,
        });
        return {
          ok: false,
          httpStatus: 409,
          error:
            "The brief changed while you were accepting it. Re-read the new version and accept again — the version you saw is not the one now on the task.",
          brief_changed: true,
        };
      }
      // wrong_state / not_found after the checks above means a race lost to
      // another decision or the inline lapse — surface it as the generic 409.
      return {
        ok: false,
        httpStatus: 409,
        error: `Task is ${accepted.currentStatus ?? "no longer"} an open offer`,
      };
    }
  } else {
    await updateTaskStatus(paymentRequestId, "declined");
  }

  log("info", decision === "accept" ? "offer_accepted" : "offer_declined", {
    payment_request_id: paymentRequestId,
    worker: task.to_human_wallet,
    amount_usdc: task.amount_usdc,
  });

  // Tell the worker's channels their own decision happened (ADR-0005 D7 seam).
  // Best-effort: notifyContractor never throws.
  const worker = await getHumanByWallet(task.to_human_wallet);
  if (worker) {
    await notifyContractor(worker.id, {
      type: decision === "accept" ? "task_accepted" : "task_declined",
      payment_request_id: paymentRequestId,
    });
  }

  return {
    ok: true,
    payment_request_id: paymentRequestId,
    status: decision === "accept" ? "accepted" : "declined",
  };
}
