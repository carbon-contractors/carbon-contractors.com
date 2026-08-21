/**
 * verdict-service.ts — turns a task into a signed verdict (CC-092).
 *
 * Both verdict surfaces — POST /api/verdict for the worker's dashboard and the
 * `get_signed_verdict` MCP tool for agents — call this one function, so there is
 * exactly one place that decides which task facts a verdict binds.
 *
 * The binding is deliberately taken from the chain, not the DB and not the caller:
 * `_consumeVerdict` reverts `VerdictCommitmentMismatch()` unless the verdict's
 * `specHash` and `evidenceHash` equal the on-chain task's, so a verdict signed
 * over caller-supplied (or zero) hashes would verify as a signature and still be
 * worthless on presentation. "The DB is not the authority on money" (CLAUDE.md)
 * applies to the read here too.
 *
 * **The `passed` decision is currently caller-supplied** because CC-083's
 * deterministic checker does not exist yet. That is a placeholder, not a policy:
 * when CC-083 lands, its output replaces the `passed`/`failureReason` arguments
 * and neither party gets to self-serve the polarity. Until then this runs on
 * Sepolia behind the coming-soon gate.
 */

import { getTaskByPaymentId } from "@/lib/db/tasks";
import { getOnChainTask, toTaskId } from "./escrow";
import { log } from "@/lib/logging";
import {
  PLACEHOLDER_CHECKER_HASH,
  buildVerdict,
  failureReasonHash,
  signVerdict,
  type SignedVerdict,
} from "./verdict-signer";

/** Machine-readable failure codes; surfaces map them to 4xx statuses. */
export const VERDICT_SERVICE_ERRORS = {
  TASK_NOT_FOUND: "task_not_found",
  NOT_DELIVERED: "not_delivered",
  CHAIN_UNAVAILABLE: "chain_unavailable",
  MISSING_FAILURE_REASON: "missing_failure_reason",
} as const;

export class VerdictServiceError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "VerdictServiceError";
  }
}

export interface IssueVerdictInput {
  paymentRequestId: string;
  /** See the file header — caller-supplied only until CC-083. */
  passed: boolean;
  /** Required when `passed` is false; becomes `breakdownHash`. */
  failureReason?: string;
}

/**
 * Read the task on-chain, bind its commitments, and sign a verdict over it.
 *
 * Refuses anything not in on-chain state `Delivered`: both presentations
 * (`claimWithVerdict`, `disputeTask`) require it, so signing earlier would hand
 * out signatures the contract cannot accept.
 */
export async function issueSignedVerdictForTask(
  input: IssueVerdictInput,
): Promise<SignedVerdict> {
  if (!input.passed && !input.failureReason?.trim()) {
    throw new VerdictServiceError(
      "A failure reason is required for a failing verdict",
      VERDICT_SERVICE_ERRORS.MISSING_FAILURE_REASON,
    );
  }

  const task = await getTaskByPaymentId(input.paymentRequestId);
  if (!task) {
    throw new VerdictServiceError("Task not found", VERDICT_SERVICE_ERRORS.TASK_NOT_FOUND);
  }

  let onChain;
  try {
    onChain = await getOnChainTask(input.paymentRequestId);
  } catch (err) {
    throw new VerdictServiceError(
      `Cannot read the task on-chain: ${err instanceof Error ? err.message : String(err)}`,
      VERDICT_SERVICE_ERRORS.CHAIN_UNAVAILABLE,
    );
  }

  if (onChain.state !== "Delivered") {
    throw new VerdictServiceError(
      `Task on-chain state is ${onChain.state}; a verdict can only be issued for delivered work`,
      VERDICT_SERVICE_ERRORS.NOT_DELIVERED,
    );
  }

  const verdict = buildVerdict({
    taskId: toTaskId(input.paymentRequestId),
    // Bound from the chain — see the file header. This is what the contract will
    // compare against in `_consumeVerdict`.
    specHash: onChain.specHash,
    evidenceHash: onChain.evidenceHash,
    passed: input.passed,
    checkerHash: PLACEHOLDER_CHECKER_HASH,
    breakdownHash: failureReasonHash(input.failureReason?.trim() || undefined),
  });

  const signed = await signVerdict(verdict);

  log("info", "verdict_issued", {
    paymentRequestId: input.paymentRequestId,
    taskId: verdict.taskId,
    passed: verdict.passed,
    signer: signed.signer,
  });

  return signed;
}
