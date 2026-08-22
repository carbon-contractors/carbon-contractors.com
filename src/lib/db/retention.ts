/**
 * retention.ts — verifiable task content retention engine (CC-087).
 *
 * Implements ADR-0002 D4 and D9:
 *
 *   D4 — deletion is keyed to terminal state plus the dispute/challenge window,
 *        not a calendar. A task that settles cleanly in three days has its
 *        content gone on day four, not day thirty.
 *   D9 — deletion must be verifiable: publish the rule (this file, versioned),
 *        emit a deletion record per task, keep it auditable. And the engine
 *        must never leak what it deletes — not into a log line, not into the
 *        candidate query's own SELECT list.
 *
 * What is cleared, per the D4 table: task_description, acceptance_spec (the
 * specHash preimage), and the description-history scratch copy (dropped by the
 * RPC). What is preserved, permanently and deliberately: spec_hash, both
 * wallets, amount, timestamps, status and the tx/escrow references — they are
 * either one-way commitments or already on-chain (D5/D6: the chain is the
 * durable record, the DB a working set). evidence_url and verdict breakdowns
 * have no columns to clear: the platform never stores them (D3 — the checker
 * streams from the agent's bucket and the verdict service is stateless), and
 * the place to add them if that ever changes is migration 019's RPC, not here.
 *
 * Scheduling is out of scope for this module — a cron/route invocation wires
 * `pruneExpiredTaskContent` the same way the CC-085 monitors are scheduled.
 */

import { getSupabaseAdmin } from "./client";
import { log } from "@/lib/logging";
import type { TaskStatus } from "./types";

/**
 * Version of the retention rule in force. Bump this whenever the rule itself
 * changes (window, field set, mechanism) — the version is stamped on every
 * pruned row and every deletion-log entry, so an audit can tell which rule a
 * given deletion obeyed (ADR-0002 D9).
 */
export const RETENTION_RULE_VERSION = "cc087.2026-08-22.1";

/**
 * Terminal statuses. On the DB's five-status model these are `completed` and
 * `expired` — the ADR's `Resolved` is an on-chain notion, and a resolved
 * dispute always lands in one of these two rows (see VALID_TRANSITIONS in
 * ./tasks.ts: disputed → completed | expired). `disputed` is NOT terminal.
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "expired"] as const;

/**
 * How long after terminal state the content survives: the outer bound of every
 * window that could reopen the task. The dispute-window duration is an open
 * item inherited from ADR-0001; until it is decided, the safe value is the
 * contract's maximum agent-set review window (14 days), which bounds any
 * claimWithVerdict/releaseAfterReview dispute path. Shorten only with that
 * decision, never by editing a call site.
 */
export const DISPUTE_WINDOW_SECONDS = 14 * 24 * 60 * 60;

/** Tasks examined per run. Bounded so one invocation cannot lock the table
 *  indefinitely; the next invocation picks up the remainder. */
export const PRUNE_BATCH_LIMIT = 200;

/** The fields the engine needs to decide eligibility — and nothing else. */
export interface RetentionCandidate {
  id: string;
  payment_request_id: string;
  status: TaskStatus;
  /** Proxy for "entered terminal state": every status transition bumps it and
   *  nothing else writes a terminal task. See migration 019's note. */
  updated_at: string;
  content_purged_at: string | null;
}

/**
 * Pure eligibility test, exported for the monitor and the tests (CC-085's
 * `verify-retention` re-derives the same predicate).
 *
 * Fails safe: an unparseable updated_at means "not eligible" — the engine
 * skips the task rather than guessing at its age.
 */
export function isPruneEligible(
  task: Pick<RetentionCandidate, "status" | "updated_at" | "content_purged_at">,
  nowUnix: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!TERMINAL_STATUSES.includes(task.status)) return false;
  if (task.content_purged_at !== null) return false;
  const terminalAtUnix = Math.floor(new Date(task.updated_at).getTime() / 1000);
  if (Number.isNaN(terminalAtUnix)) return false;
  return nowUnix - terminalAtUnix >= DISPUTE_WINDOW_SECONDS;
}

/** Outcome of one candidate's prune attempt, as returned in the run summary. */
export interface PruneOutcome {
  payment_request_id: string;
  pruned: boolean;
  /** Why not — the RPC's reason, or "ineligible_at_engine" if the local
   *  re-check rejected a row the candidate query returned. */
  reason?: string;
  deleted_at?: string;
}

export interface RetentionRunSummary {
  rule_version: string;
  /** ISO timestamp: terminal transitions older than this were in scope. */
  cutoff: string;
  considered: number;
  pruned: PruneOutcome[];
  skipped: PruneOutcome[];
  failed: { payment_request_id: string; error: string }[];
}

/**
 * Prunes the content of every task past terminal state plus the dispute
 * window. One invocation = one bounded batch; run it on a schedule.
 *
 * The engine never reads the content it deletes: the candidate SELECT lists
 * identifiers and timing only, and the deletion events carry the same. If that
 * ever changes, the privacy claim in ADR-0002 D2 is false — see D9's log trap.
 */
export async function pruneExpiredTaskContent(
  nowUnix: number = Math.floor(Date.now() / 1000),
): Promise<RetentionRunSummary> {
  const nowIso = new Date(nowUnix * 1000).toISOString();
  const cutoffIso = new Date((nowUnix - DISPUTE_WINDOW_SECONDS) * 1000).toISOString();
  const supabase = getSupabaseAdmin();

  const { data: candidates, error } = await supabase
    .from("tasks")
    .select("id,payment_request_id,status,updated_at,content_purged_at")
    .in("status", TERMINAL_STATUSES as TaskStatus[])
    .is("content_purged_at", null)
    .lt("updated_at", cutoffIso)
    .limit(PRUNE_BATCH_LIMIT);

  if (error) throw new Error(`pruneExpiredTaskContent failed: ${error.message}`);

  const summary: RetentionRunSummary = {
    rule_version: RETENTION_RULE_VERSION,
    cutoff: cutoffIso,
    considered: candidates?.length ?? 0,
    pruned: [],
    skipped: [],
    failed: [],
  };

  for (const task of (candidates ?? []) as RetentionCandidate[]) {
    // Re-check in code even though the query filtered: the predicate lives
    // here, where the tests and the monitor can see it.
    if (!isPruneEligible(task, nowUnix)) {
      summary.skipped.push({
        payment_request_id: task.payment_request_id,
        pruned: false,
        reason: "ineligible_at_engine",
      });
      continue;
    }

    const { data, error: rpcError } = await supabase.rpc("prune_task_content", {
      p_task_id: task.id,
      p_rule_version: RETENTION_RULE_VERSION,
      p_window_seconds: DISPUTE_WINDOW_SECONDS,
    });

    if (rpcError) {
      // One unprunable task must not protect every other task's content by
      // aborting the batch — but it must be visible.
      summary.failed.push({
        payment_request_id: task.payment_request_id,
        error: rpcError.message,
      });
      log("error", "task_content_prune_failed", {
        payment_request_id: task.payment_request_id,
        error: rpcError.message,
      });
      continue;
    }

    const result = data;
    if (!result?.pruned) {
      // The RPC's eligibility check is the authority — typically a race with a
      // concurrent prune or a status change since the candidate read.
      summary.skipped.push({
        payment_request_id: task.payment_request_id,
        pruned: false,
        reason: result?.reason ?? "unknown",
      });
      continue;
    }

    // The verifiable deletion event (ADR-0002 D9): task id, timestamp, rule
    // version. Identifiers and timing only — the deleted content must never
    // appear here, and the engine never held it to begin with.
    log("info", "task_content_pruned", {
      payment_request_id: task.payment_request_id,
      retention_rule_version: RETENTION_RULE_VERSION,
      deleted_at: result.deleted_at,
    });
    summary.pruned.push({
      payment_request_id: task.payment_request_id,
      pruned: true,
      deleted_at: result.deleted_at,
    });
  }

  log("info", "task_retention_enforced", {
    retention_rule_version: RETENTION_RULE_VERSION,
    cutoff: cutoffIso,
    ran_at: nowIso,
    considered: summary.considered,
    pruned: summary.pruned.length,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
  });

  return summary;
}
