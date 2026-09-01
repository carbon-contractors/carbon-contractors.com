/**
 * attestation/request.ts — build the delegated-attestation message a worker submits
 * (ADR-0008 D1/D2, A1.3).
 *
 * ## What this produces, and who sends it
 *
 * The platform signs; the **worker** submits. This module builds the EIP-712 message that
 * `EAS.attestByDelegation` verifies, so the on-chain `attester` is our verdict signer while
 * the transaction — and the gas — is the worker's. That is D1 and D2 in one object: the
 * platform transacts nowhere, and the durable copy ends up with the person whose reputation
 * it is.
 *
 * ## Why the shape is a parameter and not a constant
 *
 * The `Attest` struct differs between the two networks we target, measured 2026-08-31:
 *
 *   base-sepolia  EAS 1.2.0   9 fields, including `value` and `deadline`
 *   base-mainnet  EAS 1.0.1   7 fields, with neither
 *
 * So this builds against a `ResolvedEnvelope` read off the chain rather than a hard-coded
 * struct. Getting that wrong does not fail here — it fails inside the contract, later,
 * looking like something else entirely.
 *
 * No network access: the caller supplies the envelope, the signer nonce and the timestamp.
 * That keeps it unit-testable and leaves caching to the caller.
 */

import type { Address, Hex } from "viem";
import type { ResolvedEnvelope } from "./envelope";
import { completionSchemaUid, encodeCompletionData, type CompletionAttestationData } from "./schema";

/**
 * How long a signed request stays submittable, on the versions that carry a `deadline`.
 *
 * Matches `VERDICT_SIGNATURE_VALIDITY_SECONDS` deliberately — both are "the platform signed
 * this, go and use it", and two different windows would be two things to reason about for no
 * gain. Long enough that a worker can claim, notice the attestation, and submit it in one
 * sitting; short enough that a leaked signature is not indefinitely replayable.
 *
 * On EAS 1.0.x there is no `deadline` field, so the request does not expire. The nonce is
 * what stops replay there, and it is why `nonce` is read per-attester rather than invented.
 */
export const ATTESTATION_REQUEST_VALIDITY_SECONDS = 60 * 60;

/** Everything `attestByDelegation` needs, minus the signature. */
export interface DelegatedAttestationMessage {
  schema: Hex;
  recipient: Address;
  expirationTime: bigint;
  revocable: boolean;
  refUID: Hex;
  data: Hex;
  /** Present only on EAS 1.1+. */
  value?: bigint;
  nonce: bigint;
  /** Present only on EAS 1.1+. */
  deadline?: bigint;
}

export class AttestationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationRequestError";
  }
}

/**
 * Build the message for one completed task.
 *
 * @param envelope  From `resolveEnvelope()` — decides which fields the struct carries.
 * @param worker    The EAS `recipient`. ADR-0008 D4 keeps the worker out of the schema data
 *                  because this is where EAS puts the subject.
 * @param nonce     `EAS.getNonce(attester)`. Read, never invented: on EAS 1.0.x it is the
 *                  only replay protection, and a stale one makes the submission revert.
 * @param nowSeconds Caller's clock, so the deadline is testable and the module stays pure.
 */
export function buildDelegatedAttestation(args: {
  envelope: ResolvedEnvelope;
  worker: Address;
  completion: CompletionAttestationData;
  nonce: bigint;
  nowSeconds: number;
}): DelegatedAttestationMessage {
  const { envelope, worker, completion, nonce, nowSeconds } = args;

  // `revocable` on the attestation must not exceed the schema's. Ours is registered
  // non-revocable (ADR-0008 D4), so anything else is rejected by EAS — and a rejection at
  // submit time lands on the worker, who did nothing wrong and cannot fix it.
  const message: DelegatedAttestationMessage = {
    schema: completionSchemaUid(),
    recipient: worker,
    // Never expires. An attestation that lapses is a reputation that evaporates, which is
    // the opposite of what ADR-0008 exists to build.
    expirationTime: BigInt(0),
    revocable: false,
    // No reference to a prior attestation. The escrow taskId inside `data` is the link.
    refUID: `0x${"00".repeat(32)}`,
    data: encodeCompletionData(completion),
    nonce,
  };

  if (envelope.hasValueAndDeadline) {
    // `value` is ETH forwarded to a resolver. Ours is address(0), so it must be zero —
    // a non-zero value against no resolver is ETH sent nowhere.
    message.value = BigInt(0);
    message.deadline = BigInt(nowSeconds + ATTESTATION_REQUEST_VALIDITY_SECONDS);
  }

  return message;
}

/**
 * Order the message fields to match the envelope's type string exactly.
 *
 * viem hashes typed data by the `types` definition rather than by object key order, so this
 * is not required for correctness — it is here because the object is handed to a worker to
 * submit, and a payload whose keys read in struct order is one a human can check against
 * the contract. It also surfaces a field the envelope wants and the message lacks, which
 * would otherwise reach viem as an unhelpful encoding error.
 */
export function orderedForEnvelope(
  envelope: ResolvedEnvelope,
  message: DelegatedAttestationMessage,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { name } of envelope.types.Attest) {
    if (!(name in message)) {
      throw new AttestationRequestError(
        `The ${envelope.seenOn} Attest struct wants a "${name}" field and the message has ` +
          `none. Either the envelope resolved to a struct this module does not build for, ` +
          `or buildDelegatedAttestation needs updating for it — do not fill it with a ` +
          `default, because a wrong value here is signed and then rejected on chain.`,
      );
    }
    out[name] = (message as unknown as Record<string, unknown>)[name];
  }
  return out;
}

/**
 * A signed request, in the shape the worker hands to `attestByDelegation`.
 *
 * `attester` is recorded explicitly even though the contract recovers it from the signature:
 * whoever submits this needs to know which address to expect on the resulting attestation,
 * and confirming it is `CC-036`'s open acceptance check (ADR-0008 A1.4).
 */
export interface SignedDelegatedAttestation {
  schemaUid: Hex;
  attester: Address;
  recipient: Address;
  message: Record<string, unknown>;
  signature: Hex;
  /** Which EAS version's struct was signed against — for the submitter's own assertion. */
  envelope: string;
  /** The EAS address the signature is bound to. A signature is not portable across these. */
  eas: Address;
  chainId: number;
}
