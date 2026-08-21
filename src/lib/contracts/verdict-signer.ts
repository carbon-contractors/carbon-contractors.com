/**
 * verdict-signer.ts — the EIP-712 verdict, in exactly one place (CC-092).
 *
 * Under ADR-0001 Amendment 1 A1.1 a verdict is a signature, not a transaction: an
 * accepted signer signs this struct off-chain and hands it to whichever party needs
 * it, and CarbonEscrow's `verdictDigest`/`_consumeVerdict` recover the signer on
 * presentation. `scripts/admin/verify-escrow-lifecycle.ts` was the reference
 * implementation; this module is its promotion into `src/` so the domain separator,
 * typehash and struct encoding exist once rather than per-caller.
 *
 * The type string below must stay byte-identical to `VERDICT_TYPEHASH` in
 * `contracts/CarbonEscrow.sol` — the digest is keccak256 over it, so a single
 * renamed field silently invalidates every signature while still "verifying"
 * against a locally recomputed digest. The contract test suite pins the pair;
 * `recoverTypedDataAddress` here lets any party check a signature without an RPC.
 *
 * The signing key is `getPlatformAccount()` — KMS in production, raw key locally.
 * That is currently the contract owner as well as the accepted verdict signer;
 * separating the two is CC-090 and changes only which key this resolves to, not
 * this encoding.
 */

import { randomBytes } from "node:crypto";
import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { getEscrowConfig, toTaskId } from "./escrow";
import { getPlatformAccount } from "./signer";
import { log } from "@/lib/logging";

/** Must equal `VERDICT_TYPEHASH` in contracts/CarbonEscrow.sol. */
export const VERDICT_TYPEHASH =
  "Verdict(bytes32 taskId,bytes32 specHash,bytes32 evidenceHash,bytes32 checkerHash,bool passed,bytes32 breakdownHash,uint256 expiry,uint256 nonce)";

export const VERDICT_TYPES = {
  Verdict: [
    { name: "taskId", type: "bytes32" },
    { name: "specHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "checkerHash", type: "bytes32" },
    { name: "passed", type: "bool" },
    { name: "breakdownHash", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** Mirrors `CarbonEscrow.Verdict`. bigint fields — JSON serialise via toString(). */
export interface Verdict {
  taskId: Hash;
  specHash: Hash;
  evidenceHash: Hash;
  /** Content-addressed checker bundle (CC-083); doubles as ruleVersion. */
  checkerHash: Hash;
  passed: boolean;
  /** Per-check results, held off-chain. */
  breakdownHash: Hash;
  /** Unix seconds after which `_consumeVerdict` rejects the signature. */
  expiry: bigint;
  /** Per-signer, consumed on presentation — see `verdictNonceUsed` in the contract. */
  nonce: bigint;
}

/**
 * Default validity of a signed verdict. Unbounded signatures are replayable
 * authorisations and this struct moves money, so expiry and nonce are mandatory
 * (the contract enforces both; this just picks the window).
 */
export const VERDICT_DEFAULT_TTL_S = 3600;

/** The EIP-712 domain CarbonEscrow v2 hashes verdicts under. */
export function verdictDomain(): {
  name: "CarbonEscrow";
  version: "2";
  chainId: number;
  verifyingContract: Address;
} {
  const config = getEscrowConfig();
  if (!config.address) {
    throw new Error(
      "NEXT_PUBLIC_ESCROW_CONTRACT not set. A verdict has no domain without the deployed contract.",
    );
  }
  return {
    name: "CarbonEscrow",
    version: "2",
    chainId: config.chainId,
    verifyingContract: config.address,
  };
}

/**
 * The digest an accepted signer signs — identical to what the contract's
 * `verdictDigest(verdict)` returns on-chain. Off-chain recomputation is what makes
 * a refusal falsifiable: anyone can confirm what was signed without an RPC.
 */
export function computeVerdictDigest(verdict: Verdict): Hash {
  return hashTypedData({
    domain: verdictDomain(),
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
  });
}

export interface BuildVerdictInput {
  taskId: Hash;
  specHash: Hash;
  evidenceHash: Hash;
  passed: boolean;
  checkerHash: Hash;
  breakdownHash: Hash;
  /** Override the default 1h validity window. */
  ttlSeconds?: number;
  /** Injected by tests; otherwise a fresh 128-bit value. */
  nonce?: bigint;
  /** Injected by tests; otherwise now + ttl. */
  nowUnix?: number;
}

/** Fill in the mandate fields (expiry, nonce) the contract requires. */
export function buildVerdict(input: BuildVerdictInput): Verdict {
  const now = input.nowUnix ?? Math.floor(Date.now() / 1000);
  return {
    taskId: input.taskId,
    specHash: input.specHash,
    evidenceHash: input.evidenceHash,
    checkerHash: input.checkerHash,
    passed: input.passed,
    breakdownHash: input.breakdownHash,
    expiry: BigInt(now + (input.ttlSeconds ?? VERDICT_DEFAULT_TTL_S)),
    nonce: input.nonce ?? BigInt(`0x${randomBytes(16).toString("hex")}`),
  };
}

export interface SignedVerdict {
  verdict: Verdict;
  /** The EIP-712 digest — what the contract records as `task.verdictHash`. */
  digest: Hash;
  signature: Hex;
  /** The accepted signer's address. */
  signer: Address;
}

/** Sign a verdict with the platform account (KMS in production). */
export async function signVerdict(verdict: Verdict): Promise<SignedVerdict> {
  const account = await getPlatformAccount();
  if (!account.signTypedData) {
    throw new Error("platform account cannot signTypedData — check kms-signer.ts");
  }
  const domain = verdictDomain();
  const signature = (await account.signTypedData({
    domain,
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
  })) as Hex;
  const digest = computeVerdictDigest(verdict);
  return { verdict, digest, signature, signer: account.address };
}

/**
 * Recover the signer address from a verdict signature, with no RPC.
 * Mirrors the contract's `ECDSA.recover(digest, signature)` — a mismatch here is a
 * mismatch on-chain.
 */
export async function recoverVerdictSigner(
  verdict: Verdict,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: verdictDomain(),
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
    signature,
  });
}

/**
 * JSON shape of a signed verdict for API/MCP responses. bigint does not survive
 * JSON.stringify, so expiry and nonce travel as decimal strings; callers passing
 * the struct back to the contract must BigInt() them again.
 */
export interface SerializedVerdict {
  taskId: Hash;
  specHash: Hash;
  evidenceHash: Hash;
  checkerHash: Hash;
  passed: boolean;
  breakdownHash: Hash;
  expiry: string;
  nonce: string;
}

export function serializeVerdict(verdict: Verdict): SerializedVerdict {
  return {
    taskId: verdict.taskId,
    specHash: verdict.specHash,
    evidenceHash: verdict.evidenceHash,
    checkerHash: verdict.checkerHash,
    passed: verdict.passed,
    breakdownHash: verdict.breakdownHash,
    expiry: verdict.expiry.toString(),
    nonce: verdict.nonce.toString(),
  };
}

/** Rehydrate a SerializedVerdict into one the contract ABI will accept. */
export function deserializeVerdict(v: SerializedVerdict): Verdict {
  return {
    taskId: v.taskId,
    specHash: v.specHash,
    evidenceHash: v.evidenceHash,
    checkerHash: v.checkerHash,
    passed: v.passed,
    breakdownHash: v.breakdownHash,
    expiry: BigInt(v.expiry),
    nonce: BigInt(v.nonce),
  };
}

// ── Content hashes carried inside a verdict ─────────────────────────────────
//
// One hashing rule for the string fields a verdict commits to, so every surface
// (REST, MCP, future CC-083 checker) produces the same bytes32 for the same input.

const ZERO_BYTES32: Hash =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** keccak256 of a UTF-8 string — the commitment rule for verdict string fields. */
export function hashVerdictField(value: string): Hash {
  return keccak256(toHex(value));
}

/**
 * Placeholder checker identity until CC-083 ships a real, content-addressed
 * checker bundle. A constant rather than a zero so a verdict is always explicit
 * about *what* decided it, even while what decided it is "the platform, by hand".
 */
export const PLACEHOLDER_CHECKER_LABEL = "carbon-checker-v1";
export const PLACEHOLDER_CHECKER_HASH: Hash = hashVerdictField(
  PLACEHOLDER_CHECKER_LABEL,
);

/** Commitment to the stated failure reason; zero when a verdict passes. */
export function failureReasonHash(reason: string | undefined): Hash {
  return reason ? hashVerdictField(reason) : ZERO_BYTES32;
}

// ── Presenting a verdict ────────────────────────────────────────────────────

export type VerdictCheck =
  | { ok: true; digest: Hash; signer: Address }
  | { ok: false; reason: string };

/**
 * Validate a verdict a party is about to present to the contract, without an RPC.
 *
 * This is the app-layer half of "a bare assertion is refused before it reaches the
 * chain" (CC-092, ADR-0001 D2): `disputeTask` and `claimWithVerdict` callers hand
 * us the verdict + signature they obtained from the signing service, and this
 * checks the binding before anything is broadcast or recorded. The contract
 * re-checks everything (`_consumeVerdict`) — this exists so a bad presentation
 * fails with an explanation instead of a revert.
 *
 * Checks: the verdict names this task, its polarity matches what the caller is
 * doing (`requirePassing: true` for claims, false for disputes), it is unexpired,
 * and it recovers to the platform verdict signer. The nonce cannot be checked
 * off-chain — only the contract knows `verdictNonceUsed`.
 */
export async function verifyPresentedVerdict(opts: {
  paymentRequestId: string;
  serialized: SerializedVerdict;
  signature: Hex;
  /** true: verdict must pass (claimWithVerdict); false: must fail (disputeTask). */
  requirePassing: boolean;
  /** Injectable for tests; defaults to now. */
  nowUnix?: number;
}): Promise<VerdictCheck> {
  const verdict = deserializeVerdict(opts.serialized);

  const expectedTaskId = toTaskId(opts.paymentRequestId);
  if (verdict.taskId !== expectedTaskId) {
    return { ok: false, reason: "Verdict does not name this task (taskId mismatch)" };
  }
  if (verdict.passed !== opts.requirePassing) {
    return {
      ok: false,
      reason: opts.requirePassing
        ? "Verdict is failing — a passing verdict is required to claim"
        : "Verdict is passing — a failing signed verdict is required to dispute",
    };
  }
  const now = BigInt(opts.nowUnix ?? Math.floor(Date.now() / 1000));
  if (now > verdict.expiry) {
    return { ok: false, reason: "Verdict has expired" };
  }

  const recovered = await recoverVerdictSigner(verdict, opts.signature);
  const platform = await getPlatformAccount();
  if (recovered.toLowerCase() !== platform.address.toLowerCase()) {
    log("warn", "verdict_presentation_wrong_signer", {
      paymentRequestId: opts.paymentRequestId,
      recovered,
      expected: platform.address,
    });
    return { ok: false, reason: "Verdict signature is not from the platform verdict signer" };
  }

  return { ok: true, digest: computeVerdictDigest(verdict), signer: recovered };
}
