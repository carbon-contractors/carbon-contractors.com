/**
 * worker-actions.ts — pure helpers for the worker's own-wallet write path (CC-092).
 *
 * Everything here is client-safe (no server imports, no RPC) so the dashboard can
 * build exact contract arguments before prompting the wallet. The worker signs
 * submitWork/claim/dispute transactions from their own wallet — the platform is
 * never the sender on this path (ADR-0001 A1.2/A1.3).
 *
 * `taskId` derivation mirrors `toTaskId` in escrow.ts; it is duplicated rather
 * than imported because escrow.ts drags the server read client with it.
 */

import { keccak256, toHex, type Hash } from "viem";
import type { SerializedVerdict } from "./verdict-signer";

export const ZERO_BYTES32: Hash =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Same derivation as `toTaskId` in escrow.ts: keccak256 of the id string. */
export function paymentIdToTaskId(paymentRequestId: string): Hash {
  return keccak256(toHex(paymentRequestId));
}

/**
 * Commitment to the submitted work. Mirrors the rule the verdict service hashes
 * (`hashVerdictField` in verdict-signer.ts): keccak256 over the UTF-8 bytes. The
 * evidence itself stays off-chain — only this commitment is ever published.
 */
export function computeEvidenceHash(evidence: string): Hash {
  return keccak256(toHex(evidence));
}

/** A 0x-prefixed 32-byte value (e.g. an EAS attestation UID) or null. */
export function parseBytes32(value: string): Hash | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? (trimmed as Hash) : null;
}

/**
 * Shape a serialized verdict back into the tuple the contract ABI expects —
 * expiry and nonce travel as decimal strings over JSON and must be bigint again
 * at the contract boundary.
 */
export function toVerdictTuple(serialized: SerializedVerdict) {
  return {
    taskId: serialized.taskId,
    specHash: serialized.specHash,
    evidenceHash: serialized.evidenceHash,
    checkerHash: serialized.checkerHash,
    passed: serialized.passed,
    breakdownHash: serialized.breakdownHash,
    expiry: BigInt(serialized.expiry),
    nonce: BigInt(serialized.nonce),
  };
}
