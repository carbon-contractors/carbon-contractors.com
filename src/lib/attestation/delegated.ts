/**
 * attestation/delegated.ts — the on-demand delegated request that lets a worker publish
 * their completion on chain, paying their own gas (ADR-0008 D2, A1.3, A2.3).
 *
 * ## Signed on demand, never queued (A2.3)
 *
 * Every delegated request the verdict signer issues spends one shared, sequential EAS nonce
 * (A2.1). So nothing is signed ahead of time: when a worker asks to publish, this reads the
 * attester's **current** nonce, signs one request at it, and hands it back for immediate
 * submission. An unsubmitted request blocks nobody — the next one is signed at the same
 * nonce — and losing a race costs the loser a retry, not the attestation.
 *
 * ## Read, never assume (A1.2)
 *
 * The `Attest` struct differs between networks (Sepolia 1.2.0 has `value` and `deadline`,
 * mainnet 1.0.1 has neither) and EAS is an operator-upgradeable proxy. So the typehash is
 * read and resolved through `envelope.ts`, which refuses an unknown one; the domain built
 * from `version()` must reproduce `getDomainSeparator()`; and the `attestByDelegation`
 * calldata is encoded against the struct that matches — measured from the deployed source
 * on 2026-10-21: 1.2.0's `DelegatedAttestationRequest` ends `address attester, uint64
 * deadline`, 1.0.1's ends at `attester`.
 *
 * ## Same record as the off-chain copy
 *
 * The schema data and recipient come from `completionRecord` / `completionRecipient`, the
 * same functions the off-chain attestation uses, so the two can never describe one
 * completion differently.
 */

import { encodeFunctionData, parseSignature, type Address, type Hex } from "viem";
import { EAS_ADDRESS, readEasDelegationInputs } from "@/lib/contracts/escrow";
import { getPlatformAccount } from "@/lib/contracts/signer";
import { resolveEnvelope } from "./envelope";
import { buildDelegatedAttestation, orderedForEnvelope } from "./request";
import {
  CompletionAttestationError,
  completionRecipient,
  completionRecord,
  domainSeparatorOf,
  loadCompletedTask,
} from "./completion";

const SIGNATURE_TUPLE = {
  type: "tuple",
  components: [
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
} as const;

const REQUEST_DATA_TUPLE = {
  name: "data",
  type: "tuple",
  components: [
    { name: "recipient", type: "address" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
  ],
} as const;

/** EAS 1.1+ (`Signature`, with `deadline`). Measured on base-sepolia 1.2.0. */
export const ATTEST_BY_DELEGATION_WITH_DEADLINE = [
  {
    type: "function",
    name: "attestByDelegation",
    stateMutability: "payable",
    inputs: [
      {
        name: "delegatedRequest",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          REQUEST_DATA_TUPLE,
          { name: "signature", ...SIGNATURE_TUPLE },
          { name: "attester", type: "address" },
          { name: "deadline", type: "uint64" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** EAS 1.0.x (`EIP712Signature`, no `deadline`). Measured on base-mainnet 1.0.1. */
export const ATTEST_BY_DELEGATION_NO_DEADLINE = [
  {
    type: "function",
    name: "attestByDelegation",
    stateMutability: "payable",
    inputs: [
      {
        name: "delegatedRequest",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          REQUEST_DATA_TUPLE,
          { name: "signature", ...SIGNATURE_TUPLE },
          { name: "attester", type: "address" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** What the worker submits: send `calldata` to `to` from their own wallet, `value` 0. */
export interface DelegatedCompletionRequest {
  to: Address;
  calldata: Hex;
  chainId: number;
  /** The address the resulting attestation must name — the A1.4 read-back check. */
  attester: Address;
  recipient: Address;
  /** The EAS nonce this was signed at. Stale as soon as any other request lands. */
  nonce: string;
  /** Unix seconds after which EAS rejects it; null on 1.0.x, where requests do not expire. */
  deadline: string | null;
  /** Which EAS struct was signed against. */
  envelope: string;
}

/**
 * Sign a delegated request publishing this completion on chain. Worker-only, judged
 * against the on-chain worker before anything is signed (via `loadCompletedTask`).
 */
export async function signDelegatedCompletionRequest(
  paymentRequestId: string,
  requireWorker?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<DelegatedCompletionRequest> {
  const task = await loadCompletedTask(paymentRequestId, requireWorker);
  const { chainId } = task;

  const account = await getPlatformAccount();
  if (!account.signTypedData) {
    throw new Error("platform account cannot signTypedData — check kms-signer.ts");
  }

  const inputs = await readEasDelegationInputs(account.address);
  // Throws UnknownAttestEnvelopeError for any typehash not proven against a deployment.
  const envelope = resolveEnvelope({
    easAddress: EAS_ADDRESS,
    chainId,
    contractVersion: inputs.version,
    attestTypeHash: inputs.attestTypeHash,
  });
  if (
    domainSeparatorOf(envelope.domain, chainId).toLowerCase() !==
    inputs.domainSeparator.toLowerCase()
  ) {
    throw new CompletionAttestationError(
      `EAS version ${inputs.version} does not reproduce the chain's domain separator — refusing to sign`,
    );
  }

  const recipient = completionRecipient(task.onChain);
  const message = buildDelegatedAttestation({
    envelope,
    worker: recipient,
    completion: completionRecord(task),
    nonce: inputs.nonce,
    nowSeconds,
  });
  const signature = await account.signTypedData({
    domain: envelope.domain,
    types: envelope.types,
    primaryType: "Attest",
    message: orderedForEnvelope(envelope, message),
  });
  const { r, s, v, yParity } = parseSignature(signature);
  const sig = { v: v !== undefined ? Number(v) : 27 + (yParity ?? 0), r, s };

  const requestData = {
    recipient,
    expirationTime: message.expirationTime,
    revocable: message.revocable,
    refUID: message.refUID,
    data: message.data,
    // Not in 1.0.x's signed struct, but present in its calldata struct; a resolver of
    // address(0) means it must be zero on both.
    value: BigInt(0),
  };
  const calldata = envelope.hasValueAndDeadline
    ? encodeFunctionData({
        abi: ATTEST_BY_DELEGATION_WITH_DEADLINE,
        functionName: "attestByDelegation",
        args: [
          {
            schema: message.schema,
            data: requestData,
            signature: sig,
            attester: account.address,
            deadline: message.deadline as bigint,
          },
        ],
      })
    : encodeFunctionData({
        abi: ATTEST_BY_DELEGATION_NO_DEADLINE,
        functionName: "attestByDelegation",
        args: [{ schema: message.schema, data: requestData, signature: sig, attester: account.address }],
      });

  return {
    to: EAS_ADDRESS,
    calldata,
    chainId,
    attester: account.address,
    recipient,
    nonce: inputs.nonce.toString(),
    deadline: message.deadline !== undefined ? message.deadline.toString() : null,
    envelope: envelope.seenOn,
  };
}

