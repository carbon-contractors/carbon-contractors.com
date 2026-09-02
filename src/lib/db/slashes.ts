/**
 * slashes.ts — stake-slash records (NOR-330).
 *
 * The chain records THAT a slash happened; this table records WHICH dispute it
 * resolved. Rows are attestations written by the platform at resolution time
 * (the owner's recorder script); tx_hash is unique, so one on-chain slash can
 * never become two rows. See migration 023 for the reasoning.
 */

import { getSupabaseAdmin } from "./client";

export interface StakeSlashRecord {
  id: string;
  wallet: string;
  amount_usdc: number;
  payment_request_id: string | null;
  tx_hash: string;
  slashed_at: string;
}

export interface CreateSlashRecordInput {
  wallet: string;
  amount_usdc: number;
  payment_request_id?: string | null;
  tx_hash: string;
}

export async function createSlashRecord(
  input: CreateSlashRecordInput,
): Promise<StakeSlashRecord> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("stake_slashes")
    .insert({
      wallet: input.wallet.toLowerCase(),
      amount_usdc: input.amount_usdc,
      payment_request_id: input.payment_request_id ?? null,
      tx_hash: input.tx_hash,
    })
    .select()
    .single();

  // 23505 = unique violation on tx_hash: the slash is already recorded. Kept
  // in the message like CC-046's idempotency code so callers can treat a
  // re-run as a no-op rather than a failure.
  if (error) {
    throw new Error(
      `createSlashRecord failed${error.code ? ` (${error.code})` : ""}: ${error.message}`,
    );
  }
  return data as StakeSlashRecord;
}

export async function listSlashRecords(
  wallet: string,
): Promise<StakeSlashRecord[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("stake_slashes")
    .select()
    .eq("wallet", wallet.toLowerCase())
    .order("slashed_at", { ascending: false });
  if (error) {
    throw new Error(`listSlashRecords failed: ${error.message}`);
  }
  return (data ?? []) as StakeSlashRecord[];
}
