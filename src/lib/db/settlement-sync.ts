/**
 * settlement-sync.ts — project on-chain settlement into the tasks table (CC-080).
 *
 * The chain is the authority on money and the `tasks` table is a projection of
 * it (CC-037). Since CC-080 handed settlement back to the parties, every route
 * that ends a funded task — `completeTask`, `releaseAfterReview`,
 * `claimWithVerdict`, `releaseAfterArbitration`, `expireTask`, `resolveDispute`
 * — is a transaction the app neither sends nor observes. CC-080's Done note
 * deferred the observer, and without it no funded row ever left `active`, so:
 *
 *   - `countCommittedTasks` (accepted + active) filled after three paid jobs and
 *     the ADR-0005 D5 cap then refused that worker every further acceptance and
 *     auto-booking for good;
 *   - retention (CC-087) only prunes `completed`/`expired`, so no task content
 *     was ever deleted after settlement;
 *   - the AWOL backstop (CC-075) counts `expired` rows, and there were none.
 *
 * It polls rather than scans events: one `getTask` read per in-flight row, which
 * the client batches into multicall3 (CC-070), needs no cursor and costs a
 * fraction of an `eth_getLogs` walk. The one event lookup left is for
 * `Resolved`, whose direction only the `TaskResolved` event records.
 *
 * Mapping, applied only to rows that are `active` or `disputed`:
 *
 *   Completed                 → completed  (every payout route lands here)
 *   Expired                   → expired    (agent reclaimed; nothing delivered)
 *   Resolved                  → completed if TaskResolved.releasedToWorker, else expired
 *   Disputed / Arbitrating    → disputed   (`active` rows only — raised on chain directly)
 *   None / Funded / Delivered → unchanged  (still in flight)
 *
 * Every write goes through `updateTaskStatus`, so VALID_TRANSITIONS and its
 * atomic WHERE-status guard still decide what may move; this module proposes.
 *
 * Scheduling lives in `/api/cron/settlement-sync`, the same way retention's
 * engine is called from its cron route.
 */

import { getSupabaseAdmin } from "./client";
import { updateTaskStatus } from "./tasks";
import type { TaskStatus } from "./types";
import {
  getEscrowConfig,
  getOnChainTask,
  getTaskResolvedOutcome,
  type OnChainTask,
  type OnChainTaskState,
} from "@/lib/contracts/escrow";
import { log } from "@/lib/logging";

/**
 * Rows examined per run. Bounded so one invocation fits the cron's 60s budget;
 * the next run picks up the remainder.
 *
 * The limit is a ceiling on *in-flight* rows, not on settled ones: a row the
 * chain still reports as Funded/Delivered is left untouched, keeps its old
 * `updated_at`, and stays at the front of the oldest-first order. Past this
 * many simultaneously in-flight tasks, newer rows would not be visited until
 * older ones settle — raise the limit (or add a cursor) before that is reachable.
 */
export const SETTLEMENT_SYNC_BATCH_LIMIT = 100;

/** The DB statuses a settlement can still move. Everything else is terminal or pre-funding. */
export const SYNCABLE_STATUSES: readonly TaskStatus[] = ["active", "disputed"] as const;

const USDC_DECIMALS = 6;

/** The fields the sync needs — identifiers, the two values it re-checks, timing. Never content. */
export interface SettlementCandidate {
  payment_request_id: string;
  status: TaskStatus;
  to_human_wallet: string;
  amount_usdc: number;
  updated_at: string;
}

/**
 * The pure half of the mapping. `"resolved"` means the state alone does not
 * say which way the dispute went and the caller must read the `TaskResolved`
 * event; null means leave the row alone.
 */
export function settlementTargetFor(
  dbStatus: TaskStatus,
  chainState: OnChainTaskState,
): TaskStatus | "resolved" | null {
  switch (chainState) {
    case "Completed":
      return "completed";
    case "Expired":
      return "expired";
    case "Resolved":
      return "resolved";
    case "Disputed":
    case "Arbitrating":
      return dbStatus === "active" ? "disputed" : null;
    default:
      // None, Funded, Delivered — still in flight, or (None) not on this escrow.
      return null;
  }
}

/**
 * Whether the chain and the row agree on whose task this is and for how much —
 * the same check `/api/fund-task` makes before activation. A projection must
 * not attribute somebody else's settlement to this row.
 */
function chainMatchesRow(onChain: OnChainTask, row: SettlementCandidate): boolean {
  const expectedAmount = BigInt(Math.round(row.amount_usdc * 10 ** USDC_DECIMALS));
  return (
    onChain.worker.toLowerCase() === row.to_human_wallet.toLowerCase() &&
    onChain.amount === expectedAmount
  );
}

/**
 * The loggable part of an error. viem's full `message` appends request details
 * — the RPC URL among them, and a provider key can live in its path — while its
 * `shortMessage` is the headline alone, which is enough to triage.
 */
function errorDetail(err: unknown): string {
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
  if (typeof short === "string") return short;
  return err instanceof Error ? err.message : String(err);
}

export interface SettlementTransition {
  payment_request_id: string;
  from: TaskStatus;
  to: TaskStatus;
  on_chain_state: OnChainTaskState;
}

export interface SettlementSyncSummary {
  considered: number;
  updated: SettlementTransition[];
  /** The chain says these are still in flight. */
  unchanged: number;
  /** Settled on chain, but the on-chain worker or amount disagrees with the row. Left alone. */
  mismatched: string[];
  /** `Resolved` on chain with no `TaskResolved` event found. Left alone, retried next run. */
  outcome_missing: string[];
  failed: { payment_request_id: string; stage: "read" | "outcome" | "write"; error: string }[];
}

/**
 * Moves every in-flight row the chain has settled to the status the chain
 * implies. One invocation = one bounded batch; run it on a schedule.
 *
 * Per-row faults (an RPC error, a decode error, a transition a concurrent
 * writer got to first) are counted and logged, never thrown: one unreadable
 * task must not hold every other worker's slot hostage. Only a failure to read
 * the batch itself, or a missing escrow address, fails the run.
 */
export async function syncSettledTasks(): Promise<SettlementSyncSummary> {
  // Fail the run once rather than every row: without an address each read
  // would throw the same configuration error.
  if (!getEscrowConfig().address) {
    throw new Error("syncSettledTasks: escrow contract is not configured");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tasks")
    .select("payment_request_id,status,to_human_wallet,amount_usdc,updated_at")
    .in("status", SYNCABLE_STATUSES as TaskStatus[])
    .order("updated_at", { ascending: true })
    .limit(SETTLEMENT_SYNC_BATCH_LIMIT);

  if (error) throw new Error(`syncSettledTasks failed: ${error.message}`);
  const candidates = (data ?? []) as SettlementCandidate[];

  const summary: SettlementSyncSummary = {
    considered: candidates.length,
    updated: [],
    unchanged: 0,
    mismatched: [],
    outcome_missing: [],
    failed: [],
  };

  const fail = (
    row: SettlementCandidate,
    stage: "read" | "outcome" | "write",
    err: unknown,
  ) => {
    const detail = errorDetail(err);
    summary.failed.push({ payment_request_id: row.payment_request_id, stage, error: detail });
    log("error", "settlement_sync_row_failed", {
      payment_request_id: row.payment_request_id,
      stage,
      error: detail,
    });
  };

  // All reads in flight at once, so the client can fold them into multicall3
  // (CC-070). allSettled, so one bad read cannot take the rest with it.
  const reads = await Promise.allSettled(
    candidates.map((row) => getOnChainTask(row.payment_request_id)),
  );

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const read = reads[i];
    if (read.status === "rejected") {
      fail(row, "read", read.reason);
      continue;
    }
    const onChain = read.value;

    const proposed = settlementTargetFor(row.status, onChain.state);
    if (proposed === null) {
      summary.unchanged++;
      continue;
    }

    if (!chainMatchesRow(onChain, row)) {
      summary.mismatched.push(row.payment_request_id);
      log("error", "settlement_sync_chain_mismatch", {
        payment_request_id: row.payment_request_id,
        on_chain_state: onChain.state,
        worker_matches: onChain.worker.toLowerCase() === row.to_human_wallet.toLowerCase(),
      });
      continue;
    }

    let target: TaskStatus;
    if (proposed === "resolved") {
      // Sequential on purpose: each lookup is a newest-first log scan, and
      // running them concurrently would multiply the RPC load, not shorten it.
      let outcome: Awaited<ReturnType<typeof getTaskResolvedOutcome>>;
      try {
        outcome = await getTaskResolvedOutcome(row.payment_request_id);
      } catch (err) {
        fail(row, "outcome", err);
        continue;
      }
      if (!outcome) {
        summary.outcome_missing.push(row.payment_request_id);
        log("warn", "settlement_sync_resolved_outcome_missing", {
          payment_request_id: row.payment_request_id,
        });
        continue;
      }
      target = outcome.releasedToWorker ? "completed" : "expired";
    } else {
      target = proposed;
    }

    try {
      await updateTaskStatus(row.payment_request_id, target);
    } catch (err) {
      fail(row, "write", err);
      continue;
    }

    log("info", "task_settlement_synced", {
      payment_request_id: row.payment_request_id,
      from: row.status,
      to: target,
      on_chain_state: onChain.state,
    });
    summary.updated.push({
      payment_request_id: row.payment_request_id,
      from: row.status,
      to: target,
      on_chain_state: onChain.state,
    });
  }

  log("info", "settlement_sync_run", {
    considered: summary.considered,
    updated: summary.updated.length,
    unchanged: summary.unchanged,
    mismatched: summary.mismatched.length,
    outcome_missing: summary.outcome_missing.length,
    failed: summary.failed.length,
  });

  return summary;
}
