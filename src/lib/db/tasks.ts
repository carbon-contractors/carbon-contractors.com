/**
 * tasks.ts
 * CRUD operations for the tasks table.
 */

import { getSupabase, getSupabaseAdmin } from "./client";
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
}

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      payment_request_id: input.payment_request_id,
      from_agent_wallet: input.from_agent_wallet,
      to_human_wallet: input.to_human_wallet,
      task_description: input.task_description,
      amount_usdc: input.amount_usdc,
      deadline_unix: input.deadline_unix,
      tx_hash: input.tx_hash,
      escrow_contract: input.escrow_contract,
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
  const supabase = getSupabase();

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

export async function updateTaskStatus(
  paymentRequestId: string,
  status: TaskStatus,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("payment_request_id", paymentRequestId);

  if (error) throw new Error(`updateTaskStatus failed: ${error.message}`);
}

export async function getTasksByWallet(
  wallet: string,
): Promise<TaskRecord[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("tasks")
    .select()
    .eq("to_human_wallet", wallet)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getTasksByWallet failed: ${error.message}`);
  return (data as TaskRecord[]) ?? [];
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
