/**
 * tasks.ts
 * CRUD operations for the tasks table.
 */

import { getSupabaseAdmin, getSupabase } from "./client";
import type { TaskStatus } from "./types";

export interface TaskRecord {
  id: string;
  payment_request_id: string;
  from_agent_wallet: string;
  to_human_wallet: string;
  task_description: string;
  amount_usdc: number;
  deadline_unix: number;
  status: TaskStatus;
  tx_hash: string | null;
  escrow_contract: string | null;
  /** Verbatim spec string — the specHash preimage. Never reserialise it (CC-084). */
  acceptance_spec: string | null;
  spec_hash: string | null;
  spec_schema_version: number | null;
  /** On-chain block timestamp when Funded was confirmed. Settable once (CC-092). */
  funded_at: string | null;
  created_at: string;
}

export interface CreateTaskInput {
  payment_request_id: string;
  from_agent_wallet: string;
  to_human_wallet: string;
  task_description: string;
  amount_usdc: number;
  deadline_unix: number;
  tx_hash: string;
  escrow_contract: string;
  /** All three together or none — enforced by migration 016's tasks_spec_complete. */
  acceptance_spec?: string | null;
  spec_hash?: string | null;
  spec_schema_version?: number | null;
}

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      payment_request_id: input.payment_request_id,
      from_agent_wallet: input.from_agent_wallet.toLowerCase(),
      to_human_wallet: input.to_human_wallet.toLowerCase(),
      task_description: input.task_description,
      amount_usdc: input.amount_usdc,
      deadline_unix: input.deadline_unix,
      tx_hash: input.tx_hash,
      escrow_contract: input.escrow_contract,
      acceptance_spec: input.acceptance_spec ?? null,
      spec_hash: input.spec_hash ?? null,
      spec_schema_version: input.spec_schema_version ?? null,
      status: "pending",
    })
    .select()
    .single();

  if (error) throw new Error(`createTask failed: ${error.message}`);
  return data as TaskRecord;
}

export async function getTaskByPaymentId(
  paymentRequestId: string,
): Promise<TaskRecord | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tasks")
    .select()
    .eq("payment_request_id", paymentRequestId)
    .single();

  if (error && error.code !== "PGRST116") {
    throw new Error(`getTaskByPaymentId failed: ${error.message}`);
  }
  return (data as TaskRecord) ?? null;
}

/**
 * Valid state transitions. Prevents illegal jumps like completed→active.
 * Each key is the target status; its value lists allowed source statuses.
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: [],                         // initial state only (via createTask)
  active: ["pending"],                 // funded
  completed: ["active", "disputed"],   // work done or dispute resolved in worker's favor
  disputed: ["active", "pending"],     // either party flags
  expired: ["disputed", "pending"],    // dispute resolved in agent's favor, or timeout
};

export async function updateTaskStatus(
  paymentRequestId: string,
  status: TaskStatus,
): Promise<void> {
  const allowed = VALID_TRANSITIONS[status];
  if (allowed.length === 0) {
    throw new Error(
      `Invalid state transition: cannot transition to '${status}' (no allowed source states)`,
    );
  }

  const supabase = getSupabaseAdmin();

  // Atomic update — the WHERE clause enforces both the payment_request_id match
  // and that the current status is in the allowed source set, eliminating the
  // TOCTOU race from the previous read-then-validate-then-write approach.
  const { data, error } = await supabase
    .from("tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("payment_request_id", paymentRequestId)
    .in("status", allowed)
    .select("payment_request_id");

  if (error) throw new Error(`updateTaskStatus failed: ${error.message}`);

  if (!data || data.length === 0) {
    // Either the task doesn't exist or its current status doesn't allow this transition.
    // Fetch current state to produce a clear error message.
    const { data: current } = await supabase
      .from("tasks")
      .select("status")
      .eq("payment_request_id", paymentRequestId)
      .single();

    if (!current) {
      throw new Error(`Task not found: ${paymentRequestId}`);
    }
    throw new Error(
      `Invalid state transition: ${current.status} → ${status} (allowed from: ${allowed.join(", ")})`,
    );
  }
}

/**
 * Confirms funding: pending → active, recording the on-chain block timestamp in
 * the same write (CC-092). A dedicated function rather than a parameter on
 * `updateTaskStatus` because `funded_at` has its own once-only semantics
 * (migration 018) that no other status transition shares.
 */
export async function markTaskFunded(
  paymentRequestId: string,
  fundedAtUnixSeconds: number,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const fundedAt = new Date(fundedAtUnixSeconds * 1000).toISOString();

  const { data, error } = await supabase
    .from("tasks")
    .update({ status: "active", funded_at: fundedAt, updated_at: new Date().toISOString() })
    .eq("payment_request_id", paymentRequestId)
    .eq("status", "pending")
    .select("payment_request_id");

  if (error) throw new Error(`markTaskFunded failed: ${error.message}`);

  if (!data || data.length === 0) {
    const { data: current } = await supabase
      .from("tasks")
      .select("status")
      .eq("payment_request_id", paymentRequestId)
      .single();

    if (!current) {
      throw new Error(`Task not found: ${paymentRequestId}`);
    }
    throw new Error(
      `Invalid state transition: ${current.status} → active (allowed from: pending)`,
    );
  }
}

export async function getTasksByWallet(
  wallet: string,
): Promise<TaskRecord[]> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tasks")
    .select()
    .eq("to_human_wallet", wallet.toLowerCase())
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getTasksByWallet failed: ${error.message}`);
  return (data as TaskRecord[]) ?? [];
}

/**
 * The tasks_public projection (migration 011) — every column except
 * task_description. The view's explicit column list IS the access control;
 * never SELECT * from the underlying table into this shape (CC-093).
 */
export interface PublicTaskRecord {
  id: string;
  payment_request_id: string;
  from_agent_wallet: string;
  to_human_wallet: string;
  amount_usdc: number;
  deadline_unix: number;
  status: TaskStatus;
  tx_hash: string | null;
  escrow_contract: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Full task records for a caller who has proven ownership of `wallet`, where
 * they are either party — the worker (to_human_wallet) or the hiring agent
 * (from_agent_wallet), matching the on-chain NotParty posture of
 * CarbonEscrow.disputeTask. Callers must be authenticated by the route first;
 * this bypasses RLS via the service role (CC-093).
 */
export async function getTasksForParties(wallet: string): Promise<TaskRecord[]> {
  const w = wallet.toLowerCase();
  const supabase = getSupabaseAdmin();

  // Two explicit queries rather than a single .or() string filter, so the
  // wallet stays a bound parameter. A self-hired task would match both, so
  // dedupe by id before returning.
  const [workerRes, agentRes] = await Promise.all([
    supabase
      .from("tasks")
      .select()
      .eq("to_human_wallet", w)
      .order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select()
      .eq("from_agent_wallet", w)
      .order("created_at", { ascending: false }),
  ]);

  if (workerRes.error) {
    throw new Error(`getTasksForParties failed: ${workerRes.error.message}`);
  }
  if (agentRes.error) {
    throw new Error(`getTasksForParties failed: ${agentRes.error.message}`);
  }

  const seen = new Set<string>();
  const merged: TaskRecord[] = [];
  for (const t of [
    ...((workerRes.data as TaskRecord[]) ?? []),
    ...((agentRes.data as TaskRecord[]) ?? []),
  ]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push(t);
  }
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return merged;
}

/**
 * The public task feed, via the anon client and the tasks_public view.
 * RLS/grants do the enforcing here: the view excludes task_description and
 * anon holds SELECT on it only (migrations 011 and 015) (CC-093).
 */
export async function getPublicTasks(): Promise<PublicTaskRecord[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("tasks_public")
    .select()
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(`getPublicTasks failed: ${error.message}`);
  return (data ?? []) as PublicTaskRecord[];
}

export interface ReputationSummary {
  wallet: string;
  total_tasks: number;
  completed: number;
  disputed: number;
  expired: number;
  active: number;
  pending: number;
  total_earned_usdc: number;
  recentCompletions: number; // completed in last 30 days
  midCompletions: number; // completed 30-90 days ago
}

export async function getReputationSummary(
  wallet: string,
): Promise<ReputationSummary> {
  const tasks = await getTasksByWallet(wallet);

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

  const summary: ReputationSummary = {
    wallet,
    total_tasks: tasks.length,
    completed: 0,
    disputed: 0,
    expired: 0,
    active: 0,
    pending: 0,
    total_earned_usdc: 0,
    recentCompletions: 0,
    midCompletions: 0,
  };

  for (const t of tasks) {
    switch (t.status) {
      case "completed": {
        summary.completed++;
        summary.total_earned_usdc += t.amount_usdc;
        const age = now - new Date(t.created_at).getTime();
        if (age <= thirtyDaysMs) {
          summary.recentCompletions++;
        } else if (age <= ninetyDaysMs) {
          summary.midCompletions++;
        }
        break;
      }
      case "disputed":
        summary.disputed++;
        break;
      case "expired":
        summary.expired++;
        break;
      case "active":
        summary.active++;
        break;
      case "pending":
        summary.pending++;
        break;
    }
  }

  return summary;
}
