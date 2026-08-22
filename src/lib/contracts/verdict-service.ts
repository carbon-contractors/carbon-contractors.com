/**
 * verdict-service.ts — the verdict computation service CC-092 asks for.
 *
 * Composes three things that already exist but have never been wired together:
 * CC-084's stored acceptance spec, CC-083's deterministic checker, and this issue's
 * own `verdict.ts` signer. Reachable by either party — a worker wanting a passing
 * verdict to `claimWithVerdict`, or either party wanting a failing one to
 * `disputeTask` (v2 has no bare-assertion dispute; a signed verdict is the only way
 * in). Nothing here transacts — it returns a signature for the caller to present
 * themselves, per `ADR-0001` Amendment 1 A1.1.
 *
 * Deliberately stateless (CC-092 design note 1): the caller supplies the evidence
 * bundle on every call. This function verifies it hashes to the `evidenceHash` the
 * worker already committed on-chain at `submitWork`, runs the checker, signs, and
 * returns — nothing is written to a database.
 */

import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import { getOnChainTask, toTaskId, getEscrowConfig } from "./escrow";
import { signVerdict, randomVerdictNonce, type Verdict } from "./verdict";
import { parseAndHashSpec, SpecValidationError } from "@/lib/spec/hash";
import {
  parseAndHashEvidenceBundle,
  EvidenceBundleValidationError,
} from "@/lib/checker/evidence-hash";
import { evaluateEvidence } from "@/lib/checker/evaluator";
import type { CheckResult, TaskContext } from "@/lib/checker/types";
import type { TaskRecord } from "@/lib/db/tasks";

/** How long a signature stays presentable once issued — independent of the
 *  contract's review window, which bounds when a worker may claim, not how long
 *  a verdict the platform already signed remains valid to present. */
export const VERDICT_SIGNATURE_VALIDITY_SECONDS = 60 * 60;

/**
 * A client-correctable failure — bad input, or on-chain state the caller's
 * request does not match. Distinct from a plain `Error`, which callers should
 * treat as an unexpected/server-side failure (chain read, signing).
 */
export class VerdictInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictInputError";
  }
}

export interface ComputedVerdict {
  verdict: Verdict;
  signature: Hex;
  /** Per-criterion results, for the caller to see *why* — not itself binding. */
  checks: CheckResult[];
}

/**
 * Computes and signs a verdict for `task`, against a caller-supplied evidence
 * bundle. The caller (a route or MCP tool) is responsible for authenticating the
 * requester as a party to the task before calling this — this function only
 * checks that the evidence and spec commitments line up with the chain.
 *
 * @throws {VerdictInputError} for anything the caller can fix: malformed evidence,
 *   a task with no committed spec, a task not yet delivered, or a bundle that does
 *   not hash to the worker's on-chain commitment.
 * @throws {Error} for chain-read or signing failures — not the caller's to fix.
 */
export async function computeAndSignVerdict(
  task: TaskRecord,
  evidenceBundleRaw: string,
): Promise<ComputedVerdict> {
  if (!task.acceptance_spec || !task.spec_hash) {
    // ADR-0001: a spec-less task has nothing checkable and always resolves to the
    // worker. A verdict request against one is a caller error, not a platform gap.
    throw new VerdictInputError(
      "This task has no committed acceptance spec, so there is nothing to check — it resolves in the worker's favour by default.",
    );
  }

  const escrowConfig = getEscrowConfig();
  if (!escrowConfig.address) {
    throw new Error("Escrow contract is not configured");
  }

  const onChainTask = await getOnChainTask(task.payment_request_id);

  if (onChainTask.state === "None" || onChainTask.state === "Funded") {
    throw new VerdictInputError(
      `Task has not been delivered yet (on-chain state: ${onChainTask.state}). submitWork must be called before a verdict can be computed.`,
    );
  }

  let parsedSpec;
  try {
    parsedSpec = parseAndHashSpec(task.acceptance_spec);
  } catch (err) {
    if (err instanceof SpecValidationError) {
      // The stored spec was validated at intake — reaching this means storage or
      // the schema registry changed underneath a committed task, not bad input.
      throw new Error(`stored acceptance_spec no longer validates: ${err.message}`);
    }
    throw err;
  }

  if (parsedSpec.hash !== onChainTask.specHash) {
    // Should be unreachable — migration 016 makes the spec columns immutable, and
    // the agent commits this same hash at createTask. Loud rather than silent if
    // it ever happens, per ADR-0001 D5's re-runnability requirement.
    throw new Error(
      `stored spec_hash (${parsedSpec.hash}) does not match the on-chain specHash (${onChainTask.specHash}) for this task`,
    );
  }

  let parsedEvidence;
  try {
    parsedEvidence = parseAndHashEvidenceBundle(evidenceBundleRaw);
  } catch (err) {
    if (err instanceof EvidenceBundleValidationError) {
      throw new VerdictInputError(err.message);
    }
    throw err;
  }

  if (parsedEvidence.hash !== onChainTask.evidenceHash) {
    throw new VerdictInputError(
      "The supplied evidence bundle does not hash to this task's on-chain evidenceHash — it is not the bundle the worker committed to at submitWork.",
    );
  }

  if (!task.funded_at) {
    // CC-092 PR 2 captures this at /api/fund-task. A task that reached Delivered
    // without it went through some path other than that route.
    throw new Error(
      `task ${task.payment_request_id} has no funded_at recorded, but is ${onChainTask.state} on-chain — cannot evaluate captured_after`,
    );
  }

  const context: TaskContext = {
    fundingBlockTimestamp: Math.floor(new Date(task.funded_at).getTime() / 1000),
    deadlineTimestamp: Number(onChainTask.deadline),
  };

  const checkerVerdict = evaluateEvidence(parsedSpec.spec, parsedEvidence.bundle, context);

  const verdict: Verdict = {
    taskId: toTaskId(task.payment_request_id),
    specHash: parsedSpec.hash,
    evidenceHash: parsedEvidence.hash,
    checkerHash: checkerVerdict.checkerHash,
    passed: checkerVerdict.passed,
    breakdownHash: hashBreakdown(checkerVerdict.checks),
    expiry: BigInt(Math.floor(Date.now() / 1000) + VERDICT_SIGNATURE_VALIDITY_SECONDS),
    nonce: randomVerdictNonce(),
  };

  const signature = await signVerdict(escrowConfig.address as Address, verdict);

  return { verdict, signature, checks: checkerVerdict.checks };
}

/**
 * `breakdownHash` — "per-check results, held off-chain" (`CarbonEscrow.sol`). Same
 * exact-bytes idiom as `hashSpecPreimage`/`hashEvidenceBundlePreimage`: the checker
 * is deterministic, so `JSON.stringify(checks)` is byte-identical on any re-run.
 */
function hashBreakdown(checks: CheckResult[]): Hex {
  return keccak256(toHex(JSON.stringify(checks)));
}
