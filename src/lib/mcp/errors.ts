/**
 * errors.ts
 * CC-046: structured retry/failure semantics for MCP tools.
 *
 * Every tool failure returns JSON of the shape
 *   { ok: false, error: string, code: string, retryable: boolean, reason?: string }
 * so an autonomous agent can classify the failure without parsing prose:
 *   retryable=true  — an identical retry (after backoff / retry_after_s) may succeed
 *   retryable=false — the request itself must change; retrying wastes the call
 */

/** Stable, machine-readable failure classes. Never rename one — callers branch on these. */
export type ToolErrorCode =
  | "UNAUTHENTICATED" // no verified caller wallet
  | "INTAKE_PAUSED" // emergency kill switch (ADR-0003 D4)
  | "RATE_LIMITED" // too many requests from this caller
  | "UNREGISTERED_WORKER" // to_human_wallet is not in the whitepages
  | "WORKER_AT_CAPACITY" // worker at the ADR-0005 D5 concurrency cap
  | "ACCEPTANCE_SPEC_REQUIRED" // no spec — nothing to check (ADR-0001 D6)
  | "INVALID_SPEC" // spec failed schema validation
  | "INVALID_ARGUMENT" // argument fails a non-schema validation rule
  | "TASK_NOT_FOUND" // no task with that payment_request_id
  | "CONTRACTOR_NOT_FOUND" // no contractor with that wallet/id
  | "FORBIDDEN" // authenticated, but not a party/owner for this action
  | "SANCTIONED_WALLET" // caller or target wallet is restricted (CC-099); never retry
  | "INVALID_TASK_STATE" // task status does not allow this action
  | "VERDICT_INPUT_INVALID" // evidence bundle rejected — deterministic, will fail identically
  | "VERDICT_COMPUTATION_FAILED" // verdict computation failed on our side
  | "VERDICT_PASSED" // cannot dispute: the evidence satisfies the spec
  | "DISPUTE_REQUIRES_VERDICT" // v2 has no bare-assertion dispute (ADR-0001 D2)
  | "CHAIN_STATE_MISMATCH" // DB and chain disagree — needs a human look
  | "CHAIN_WRITE_FAILED" // on-chain transaction failed (gas/reorg/RPC)
  | "INTERNAL"; // unexpected fault — retrying is reasonable

/** Codes where an identical retry after backoff can succeed. */
const RETRYABLE_CODES: ReadonlySet<ToolErrorCode> = new Set([
  "INTAKE_PAUSED",
  "RATE_LIMITED",
  "VERDICT_COMPUTATION_FAILED",
  "CHAIN_WRITE_FAILED",
  "INTERNAL",
]);

export interface ToolErrorOptions {
  /** Override the code's default retry classification. */
  retryable?: boolean;
  /** Short machine-readable cause, e.g. "duplicate_idempotency_key". */
  reason?: string;
  /** Additional structured fields (retry_after_s, intake_paused, ...). */
  extra?: Record<string, unknown>;
}

/**
 * Builds the standard MCP tool error response. `error` stays human-readable
 * (existing consumers assert on its text); `code` and `retryable` are the
 * machine contract added by CC-046.
 */
export function toolError(
  error: string,
  code: ToolErrorCode,
  options: ToolErrorOptions = {},
) {
  const retryable = options.retryable ?? RETRYABLE_CODES.has(code);
  const payload = {
    ok: false as const,
    error,
    code,
    retryable,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.extra ?? {}),
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
