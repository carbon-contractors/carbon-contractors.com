/**
 * upload-credentials.ts — the agent's evidence-bucket credential store
 * (ADR-0010, migration 027). Service role only.
 *
 * Holds ciphertext, never a secret: encryption and decryption happen in
 * src/lib/evidence/credential-crypto.ts, on either side of these calls. The
 * row is deleted by a database trigger when the task reaches a terminal state
 * — nothing in the application deletes it, so no code path can forget to.
 */

import { getSupabaseAdmin } from "./client";

export interface UploadCredentialRow {
  payment_request_id: string;
  provider: "s3" | "gcs";
  credential_envelope: string;
  max_upload_bytes: number;
}

export async function storeUploadCredential(row: UploadCredentialRow): Promise<void> {
  const { error } = await getSupabaseAdmin().from("task_upload_credentials").insert(row);
  if (error) {
    throw new Error(
      `storeUploadCredential failed${error.code ? ` (${error.code})` : ""}: ${error.message}`,
    );
  }
}

export async function getUploadCredential(
  paymentRequestId: string,
): Promise<UploadCredentialRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("task_upload_credentials")
    .select("payment_request_id, provider, credential_envelope, max_upload_bytes")
    .eq("payment_request_id", paymentRequestId)
    .maybeSingle();
  if (error) throw new Error(`getUploadCredential failed: ${error.message}`);
  return (data as UploadCredentialRow | null) ?? null;
}

/**
 * Which of these tasks can take platform-minted uploads, and each one's cap —
 * for the dashboard. Never selects the envelope.
 */
export async function getUploadCaps(
  paymentRequestIds: string[],
): Promise<Map<string, number>> {
  if (paymentRequestIds.length === 0) return new Map();
  const { data, error } = await getSupabaseAdmin()
    .from("task_upload_credentials")
    .select("payment_request_id, max_upload_bytes")
    .in("payment_request_id", paymentRequestIds);
  if (error) throw new Error(`getUploadCaps failed: ${error.message}`);
  return new Map(
    (data ?? []).map((r: { payment_request_id: string; max_upload_bytes: number }) => [
      r.payment_request_id,
      r.max_upload_bytes,
    ]),
  );
}
