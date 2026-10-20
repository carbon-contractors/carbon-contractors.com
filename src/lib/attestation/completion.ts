/**
 * attestation/completion.ts — sign the off-chain completion attestation a worker holds
 * (ADR-0008 D1/D3, A2.3, A3).
 *
 * ## What this does
 *
 * Given a task the escrow has paid out to its worker, it builds the `COMPLETION_SCHEMA`
 * record from the chain, wraps it in the SDK's off-chain Version 2 envelope (`offchain.ts`)
 * and signs it with the verdict signer. The platform sends no transaction — the worker
 * holds the signed object, and may later anchor it with `timestamp(uid)` or publish it
 * through a delegated request (A2.3–A2.4).
 *
 * ## One completion, one attestation — without storing anything (A3.2)
 *
 * Every input comes from the chain: the task, the payout event, that block's timestamp.
 * The salt is derived from (chainId, escrow, taskId) rather than drawn at random. So
 * signing the same completion twice yields the **same message and the same UID**; a
 * second signature over it is just another valid signature of one attestation. A worker
 * cannot mint a second attestation for one job by asking twice.
 *
 * ## Read, never assume (A1.2)
 *
 * EAS is an operator-upgradeable proxy. `version()` is read at signing time and proven
 * by recomputing the *delegated* domain separator and matching `getDomainSeparator()` —
 * the method `chain-constants.test.ts` pins. Only then is the off-chain domain, which
 * nothing on chain exposes, built from the same version.
 */

import {
  encodeAbiParameters,
  hashDomain,
  keccak256,
  parseSignature,
  type Address,
  type Hex,
} from "viem";
import {
  EAS_ADDRESS,
  getEscrowConfig,
  getOnChainTask,
  getTaskCompletion,
  readEasDomainInputs,
  toTaskId,
  type OnChainTask,
  type TaskCompletionRecord,
} from "@/lib/contracts/escrow";
import { getPlatformAccount } from "@/lib/contracts/signer";
import { CHECKER_RULE_VERSION, getCheckerHash } from "@/lib/checker/hash";
import {
  CompletionRoute,
  completionSchemaUid,
  encodeCompletionData,
  type CompletionRouteValue,
} from "./schema";
import { easDomain } from "./envelope";
import {
  OFFCHAIN_ATTEST_TYPES,
  OFFCHAIN_ATTESTATION_VERSION,
  offchainDomain,
  offchainUid,
  type OffchainAttestationMessage,
} from "./offchain";

const ZERO32: Hex = `0x${"00".repeat(32)}`;

/** Domain tag for the derived salt. Changing it changes every UID — never edit it. */
export const COMPLETION_SALT_TAG = "carbon-contractors/CC-036/completion/v1";

export class CompletionAttestationError extends Error {
  constructor(
    message: string,
    /** "forbidden" when the caller is not the on-chain worker; "not_completed" otherwise. */
    readonly reason: "not_completed" | "forbidden" | "refused" = "refused",
  ) {
    super(message);
    this.name = "CompletionAttestationError";
  }
}

/** The contract's `CompletionRoute`, or `ArbitrationRuling` for an owner ruling (A3.1). */
export function routeFor(record: TaskCompletionRecord): CompletionRouteValue {
  if (record.routeRaw === null) return CompletionRoute.ArbitrationRuling;
  const known = Object.values(CompletionRoute) as number[];
  if (record.routeRaw === CompletionRoute.ArbitrationRuling || !known.includes(record.routeRaw)) {
    // A route this build does not know means the contract gained one. Refusing is safer
    // than attesting a number whose meaning nobody has written down.
    throw new CompletionAttestationError(
      `Unknown completion route ${record.routeRaw} — update CompletionRoute and ADR-0008 A3.1`,
    );
  }
  return record.routeRaw as CompletionRouteValue;
}

/**
 * The checker digest behind a verdict. Not on chain and not persisted: a verdict carries it
 * inside a digest that cannot be inverted. While only one checker rule version has ever
 * existed it is known exactly; the moment a second exists, verdicts must persist theirs
 * (A3.3), and this refuses rather than guess.
 */
export function checkerHashFor(verdictHash: Hex): Hex {
  if (verdictHash.toLowerCase() === ZERO32) return ZERO32;
  if (CHECKER_RULE_VERSION !== 1) {
    throw new CompletionAttestationError(
      "Cannot derive checkerHash: more than one checker rule version exists, so verdicts " +
        "must persist theirs before completions can be attested (ADR-0008 A3.3)",
    );
  }
  return getCheckerHash();
}

/** keccak256(abi.encode(tag, chainId, escrow, taskId)). Unique per completion, stable across re-signs. */
export function completionSalt(chainId: number, escrow: Address, taskId: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [COMPLETION_SALT_TAG, BigInt(chainId), escrow, taskId],
    ),
  );
}

/** Pure: the off-chain message for one completed task. */
export function buildCompletionMessage(args: {
  taskId: Hex;
  escrow: Address;
  chainId: number;
  onChain: OnChainTask;
  completion: TaskCompletionRecord;
}): OffchainAttestationMessage {
  const { taskId, escrow, chainId, onChain, completion } = args;
  const data = encodeCompletionData({
    taskId,
    escrow,
    chainId: BigInt(chainId),
    agent: onChain.agent,
    amountUsdc: completion.amount,
    route: routeFor(completion),
    completedAt: completion.completedAt,
    specHash: onChain.specHash,
    evidenceHash: onChain.evidenceHash,
    verdictHash: onChain.verdictHash,
    checkerHash: checkerHashFor(onChain.verdictHash),
  });
  return {
    schema: completionSchemaUid(),
    // The worker from the CONTRACT, never Supabase (CC-037).
    recipient: onChain.worker.toLowerCase() as Address,
    time: completion.completedAt,
    expirationTime: BigInt(0),
    revocable: false,
    refUID: ZERO32,
    data,
    salt: completionSalt(chainId, escrow, taskId),
  };
}

/** The EAS SDK's `{ sig, signer }` share format, with bigints as decimal strings for JSON. */
export interface SignedCompletionAttestation {
  sig: {
    version: number;
    uid: Hex;
    domain: { name: string; version: string; chainId: string; verifyingContract: Address };
    primaryType: "Attest";
    types: typeof OFFCHAIN_ATTEST_TYPES;
    message: Record<string, string | number | boolean>;
    signature: { r: Hex; s: Hex; v: number };
  };
  signer: Address;
}

/**
 * Sign the completion attestation for a task the escrow has paid to its worker.
 * Throws `CompletionAttestationError` when the task has not completed for the worker.
 */
export async function signCompletionAttestation(
  paymentRequestId: string,
  /** When set, refuse unless this is the on-chain worker — checked before anything is signed. */
  requireWorker?: string,
): Promise<SignedCompletionAttestation> {
  const { address: escrow, chainId } = getEscrowConfig();
  if (!escrow) throw new CompletionAttestationError("Escrow contract is not configured");

  const [onChain, completion] = await Promise.all([
    getOnChainTask(paymentRequestId),
    getTaskCompletion(paymentRequestId),
  ]);
  if (requireWorker && onChain.worker.toLowerCase() !== requireWorker.toLowerCase()) {
    throw new CompletionAttestationError("Caller is not this task's worker", "forbidden");
  }
  if (!completion) {
    throw new CompletionAttestationError(
      `Task has not paid its worker on chain (state: ${onChain.state})`,
      "not_completed",
    );
  }

  const { version, domainSeparator } = await readEasDomainInputs();
  const proven = hashDomain({
    domain: { ...easDomain(EAS_ADDRESS, chainId, version), chainId: BigInt(chainId) } as {
      name: string;
      version: string;
      chainId: bigint;
      verifyingContract: Address;
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    } as const,
  });
  if (proven.toLowerCase() !== domainSeparator.toLowerCase()) {
    throw new CompletionAttestationError(
      `EAS version ${version} does not reproduce the chain's domain separator — refusing to sign`,
    );
  }

  const taskId = toTaskId(paymentRequestId);
  const message = buildCompletionMessage({ taskId, escrow, chainId, onChain, completion });
  const domain = offchainDomain(EAS_ADDRESS, chainId, version);

  const account = await getPlatformAccount();
  if (!account.signTypedData) {
    throw new Error("platform account cannot signTypedData — check kms-signer.ts");
  }
  const signature = await account.signTypedData({
    domain,
    types: OFFCHAIN_ATTEST_TYPES,
    primaryType: "Attest",
    message: { version: OFFCHAIN_ATTESTATION_VERSION, ...message },
  });
  const { r, s, v, yParity } = parseSignature(signature);

  return {
    sig: {
      version: OFFCHAIN_ATTESTATION_VERSION,
      uid: offchainUid(message),
      domain: {
        name: domain.name as string,
        version,
        chainId: String(chainId),
        verifyingContract: EAS_ADDRESS,
      },
      primaryType: "Attest",
      types: OFFCHAIN_ATTEST_TYPES,
      message: {
        version: OFFCHAIN_ATTESTATION_VERSION,
        schema: message.schema,
        recipient: message.recipient,
        time: message.time.toString(),
        expirationTime: message.expirationTime.toString(),
        revocable: message.revocable,
        refUID: message.refUID,
        data: message.data,
        salt: message.salt,
      },
      signature: { r, s, v: v !== undefined ? Number(v) : 27 + (yParity ?? 0) },
    },
    signer: account.address,
  };
}
