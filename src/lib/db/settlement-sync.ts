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
 * Candidates are rows that are `active` or `disputed` **and** were created
 * against the escrow this deployment reads (`escrow_contract`). A redeploy leaves
 * rows in flight on the superseded contract (ESCROW-REDEPLOY.md: "nothing
 * migrates them"), and reading their ids against the new one would let anyone
 * settle them there: see the query.
 *
 * Mapping:
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
 * Oldest-first is not a fair queue. A row the chain still reports as
 * Funded/Delivered is left untouched, keeps its old `updated_at`, and stays at
 * the front — and rows that will *never* settle accumulate there for good: a
 * Funded task whose agent walks away without calling `expireTask` (a
 * pull-payment, so nobody else can), a Delivered task whose worker never
 * claims. Once this many of those exist the sync stops reaching any newer row,
 * however few tasks are actually live. The fix is a cursor, or ordering by a
 * column the sync bumps on each visit; both need a migration and are follow-up
 * work, needed before launch.
 */
export const SETTLEMENT_SYNC_BATCH_LIMIT = 100;

/**
 * How long into a run a `TaskResolved` lookup may still be started. Each one is
 * a newest-first `eth_getLogs` walk bounded only by ESCROW_DEPLOY_BLOCK, so after
 * a long sync outage a single lookup can outlast the cron's 60s `maxDuration`.
 * The lookups therefore run after every other row has been written, and stop
 * being started once this much of the run is spent: a slow scan can delay other
 * Resolved rows, never a Completed or Expired row queued behind it.
 */
export const SETTLEMENT_SYNC_OUTCOME_BUDGET_MS = 40_000;

/** The DB statuses a settlement can still move. Everything else is terminal or pre-funding. */
export const SYNCABLE_STATUSES: readonly TaskStatus[] = ["active", "disputed"] as const;

const USDC_DECIMALS = 6;

/** What makes `ilike` an equality test: a hex address carries no wildcard characters. */
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The fields the sync needs — identifiers, the values it re-checks, timing. Never content. */
export interface SettlementCandidate {
  payment_request_id: string;
  status: TaskStatus;
  to_human_wallet: string;
  amount_usdc: number;
  escrow_contract: string | null;
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
 * the same check `/api/fund-task` makes before activation. A consistency check,
 * not the boundary: `tasks_public` publishes the id, worker and amount of every
 * live row, so on a contract the row was never funded on anyone can create a
 * matching task. Restricting candidates to the row's own escrow is what stops
 * somebody else's settlement being attributed to this row.
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
  /**
   * Nothing to write: the chain says still in flight, or the row already holds
   * the status the chain implies (a duplicate cron delivery got there first).
   */
  unchanged: number;
  /**
   * The row is not on the configured escrow, or it is settled on chain with a
   * worker or amount that disagrees with the row. Left alone.
   */
  mismatched: string[];
  /** `Resolved` on chain with no `TaskResolved` event found. Left alone, retried next run. */
  outcome_missing: string[];
  /** `Resolved` rows whose event lookup the run's time budget did not reach. First next run. */
  deferred: string[];
  failed: { payment_request_id: string; stage: "read" | "outcome" | "write"; error: string }[];
}

/** The row's status now, or null if it cannot be read. Only used after a refused write. */
async function currentStatus(paymentRequestId: string): Promise<TaskStatus | null> {
  try {
    const { data } = await getSupabaseAdmin()
      .from("tasks")
      .select("status")
      .eq("payment_request_id", paymentRequestId)
      .single();
    return (data?.status as TaskStatus | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Moves every in-flight row the chain has settled to the status the chain
 * implies. One invocation = one bounded batch; run it on a schedule.
 *
 * Per-row faults (an RPC error, a decode error, a transition a concurrent
 * writer got to first) are counted and logged, never thrown: one unreadable
 * task must not hold every other worker's slot hostage. Only a failure to read
 * the batch itself, or a missing or malformed escrow address, fails the run.
 */
export async function syncSettledTasks(): Promise<SettlementSyncSummary> {
  // Fail the run once rather than every row: without an address each read
  // would throw the same configuration error.
  const escrow = getEscrowConfig().address;
  if (!escrow) {
    throw new Error("syncSettledTasks: escrow contract is not configured");
  }
  if (!HEX_ADDRESS.test(escrow)) {
    throw new Error("syncSettledTasks: escrow contract address is malformed");
  }
  const startedAt = Date.now();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tasks")
    .select("payment_request_id,status,to_human_wallet,amount_usdc,escrow_contract,updated_at")
    .in("status", SYNCABLE_STATUSES as TaskStatus[])
    // Only rows created against the escrow every read below goes to. A row left
    // in flight on a superseded escrow must not be judged by the new one:
    // `createTask` is permissionless and `tasks_public` publishes the id, worker
    // and amount, so anyone can create and then expire a matching task there for
    // the cost of gas — and the row would go `expired`, losing its upload
    // credential and, to retention, the spec preimage a verdict needs, while the
    // money still sits in the old contract. Filtering here rather than after the
    // read also keeps such rows, which never settle here, out of the batch.
    .ilike("escrow_contract", escrow)
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
    deferred: [],
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

  const write = async (
    row: SettlementCandidate,
    target: TaskStatus,
    onChainState: OnChainTaskState,
  ) => {
    try {
      await updateTaskStatus(row.payment_request_id, target);
    } catch (err) {
      // The guard refused. If the row already holds the target — a duplicate
      // cron delivery, an overlapping run, the dispute route racing
      // active → disputed — there was nothing to do, which is not a failure.
      if ((await currentStatus(row.payment_request_id)) === target) {
        summary.unchanged++;
        return;
      }
      fail(row, "write", err);
      return;
    }

    log("info", "task_settlement_synced", {
      payment_request_id: row.payment_request_id,
      from: row.status,
      to: target,
      on_chain_state: onChainState,
    });
    summary.updated.push({
      payment_request_id: row.payment_request_id,
      from: row.status,
      to: target,
      on_chain_state: onChainState,
    });
  };

  // The query is the guard; this repeats it, so a filter that silently stopped
  // applying cannot send a row to the wrong contract or move a terminal one.
  const inScope = candidates.filter((row) => {
    if (!SYNCABLE_STATUSES.includes(row.status)) {
      summary.unchanged++;
      return false;
    }
    if (row.escrow_contract?.toLowerCase() !== escrow.toLowerCase()) {
      summary.mismatched.push(row.payment_request_id);
      log("error", "settlement_sync_escrow_mismatch", {
        payment_request_id: row.payment_request_id,
      });
      return false;
    }
    return true;
  });

  // All reads in flight at once, so the client can fold them into multicall3
  // (CC-070). allSettled, so one bad read cannot take the rest with it.
  const reads = await Promise.allSettled(
    inScope.map((row) => getOnChainTask(row.payment_request_id)),
  );

  const resolved: { row: SettlementCandidate; onChain: OnChainTask }[] = [];

  for (let i = 0; i < inScope.length; i++) {
    const row = inScope[i];
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

    if (proposed === "resolved") {
      resolved.push({ row, onChain });
      continue;
    }
    await write(row, proposed, onChain.state);
  }

  // Resolved rows last: each needs an event lookup that can be slow (see
  // SETTLEMENT_SYNC_OUTCOME_BUDGET_MS), and no other row should wait on one.
  for (const { row, onChain } of resolved) {
    if (Date.now() - startedAt >= SETTLEMENT_SYNC_OUTCOME_BUDGET_MS) {
      summary.deferred.push(row.payment_request_id);
      continue;
    }
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
    await write(row, outcome.releasedToWorker ? "completed" : "expired", onChain.state);
  }

  if (summary.deferred.length > 0) {
    log("warn", "settlement_sync_outcome_lookups_deferred", {
      deferred: summary.deferred.length,
      budget_ms: SETTLEMENT_SYNC_OUTCOME_BUDGET_MS,
    });
  }

  log("info", "settlement_sync_run", {
    considered: summary.considered,
    updated: summary.updated.length,
    unchanged: summary.unchanged,
    mismatched: summary.mismatched.length,
    outcome_missing: summary.outcome_missing.length,
    deferred: summary.deferred.length,
    failed: summary.failed.length,
  });

  return summary;
}
