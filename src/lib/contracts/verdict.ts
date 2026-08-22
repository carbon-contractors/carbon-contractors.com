/**
 * verdict.ts — EIP-712 verdict signing (ADR-0001 Amendment 1 A1.1, CC-092).
 *
 * CarbonEscrow v2's entire settlement model is the platform producing this one
 * signature and handing it to whichever party needs it — a worker presenting a
 * passing verdict to claimWithVerdict, or either party presenting a failing one
 * to disputeTask. The platform never transacts. Before this module the only
 * implementation anywhere in the repo was scripts/admin/verify-escrow-lifecycle.ts's
 * signVerdict, so nothing in src/ could produce one and neither claimWithVerdict
 * nor disputeTask was reachable through the product (CC-092).
 *
 * The domain, typehash and field order below MUST match
 * contracts/CarbonEscrow.sol's VERDICT_TYPEHASH and EIP712("CarbonEscrow", "2")
 * exactly, or ECDSA.recover resolves to a different address than the one that
 * signed, and every verdict this produces reverts VerdictSignerNotAccepted.
 */

import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { getPlatformAccount } from "./signer";
import { getEscrowConfig } from "./escrow";

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

export interface Verdict {
  taskId: Hex;
  specHash: Hex;
  evidenceHash: Hex;
  checkerHash: Hex;
  passed: boolean;
  breakdownHash: Hex;
  expiry: bigint;
  nonce: bigint;
}

/**
 * Signs `verdict` with the platform's verdict-signing account — KMS in
 * production, DEPLOYER_PRIVATE_KEY locally (both via getPlatformAccount()).
 *
 * `escrow` is the domain's verifyingContract; the chainId comes from
 * getEscrowConfig() (NEXT_PUBLIC_BASE_NETWORK) rather than a hardcoded chain,
 * so this signs correctly against either the Sepolia or mainnet deployment.
 */
export async function signVerdict(escrow: Address, verdict: Verdict): Promise<Hex> {
  const account = await getPlatformAccount();
  if (!account.signTypedData) {
    throw new Error("platform account cannot signTypedData — check kms-signer.ts");
  }
  const { chainId } = getEscrowConfig();
  return account.signTypedData({
    domain: {
      name: "CarbonEscrow",
      version: "2",
      chainId,
      verifyingContract: escrow,
    },
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
  });
}

/** The tuple shape CARBON_ESCROW_ABI's claimWithVerdict/disputeTask expect as `verdict`. */
export function verdictTuple(v: Verdict) {
  return {
    taskId: v.taskId,
    specHash: v.specHash,
    evidenceHash: v.evidenceHash,
    checkerHash: v.checkerHash,
    passed: v.passed,
    breakdownHash: v.breakdownHash,
    expiry: v.expiry,
    nonce: v.nonce,
  };
}

/**
 * A fresh, single-use nonce. `verdictNonceUsed` is tracked per-signer on-chain
 * (CarbonEscrow.sol:139), so collision risk is birthday-bound over one signer
 * key's lifetime — 8 random bytes is ample.
 */
export function randomVerdictNonce(): bigint {
  return BigInt(`0x${randomBytes(8).toString("hex")}`);
}
