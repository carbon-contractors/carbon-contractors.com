/**
 * signer.ts
 * Platform wallet client for server-side escrow write operations.
 *
 * Uses GCP Cloud KMS when GCP_KMS_KEY_PATH is set (deployed environments).
 * Falls back to DEPLOYER_PRIVATE_KEY for local development.
 * Both paths return a viem-compatible account — consuming code is unchanged.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { CARBON_ESCROW_ABI } from "./escrow-abi";
import { createKmsAccount } from "./kms-signer";
import { getConfig } from "@/lib/config";
import { log } from "@/lib/logging";

// ── Lazy-initialized clients ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _walletClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicClient: any = null;
let _account: LocalAccount | null = null;

function getChainConfig() {
  const config = getConfig();
  const chain =
    config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  const rpcUrl =
    config.NEXT_PUBLIC_BASE_NETWORK === "mainnet"
      ? (config.BASE_MAINNET_RPC_URL ?? chain.rpcUrls.default.http[0])
      : (config.BASE_SEPOLIA_RPC_URL ?? chain.rpcUrls.default.http[0]);
  return { chain, rpcUrl };
}

/**
 * The platform's signing account — KMS-backed in production, a raw key locally.
 *
 * Exported since CC-082 because signing is no longer only about sending transactions.
 * Under `ADR-0001` Amendment 1 the platform's entire role in settlement is producing an
 * EIP-712 verdict signature and handing it to the parties; it never transacts. Callers
 * that need `signTypedData` rather than a wallet client want this directly.
 */
export async function getPlatformAccount(): Promise<LocalAccount> {
  if (_account) return _account;

  const config = getConfig();

  if (config.GCP_KMS_KEY_PATH) {
    log("info", "signer_using_kms", { keyPath: config.GCP_KMS_KEY_PATH });
    _account = await createKmsAccount();
    return _account;
  }

  // Fallback: raw private key (local dev / testnet)
  const key = config.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Neither GCP_KMS_KEY_PATH nor DEPLOYER_PRIVATE_KEY is set. " +
        "One is required for server-side escrow operations.",
    );
  }
  _account = privateKeyToAccount(key as `0x${string}`, { nonceManager });
  return _account;
}

async function getWalletClient() {
  if (_walletClient) return _walletClient;
  const { chain, rpcUrl } = getChainConfig();
  const account = await getPlatformAccount();
  _walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
  return _walletClient;
}

function getPublicClient() {
  if (_publicClient) return _publicClient;
  const { chain, rpcUrl } = getChainConfig();
  _publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return _publicClient;
}

function getEscrowAddress(): Address {
  const addr = getConfig().NEXT_PUBLIC_ESCROW_CONTRACT as Address | undefined;
  if (!addr) {
    throw new Error(
      "NEXT_PUBLIC_ESCROW_CONTRACT not set. Deploy the contract first.",
    );
  }
  return addr;
}

// ── Write operations ────────────────────────────────────────────────────────

// completeTaskOnChain was removed here (CC-080). It could never succeed:
// `completeTask` requires `msg.sender == task.agent` and the platform signer is
// structurally the wrong sender. Under ADR-0001 completion is the agent's own
// early path; the worker's default path is the pull-payment claim. There is no
// platform transaction anywhere in settlement — do not reintroduce one.

/**
 * Call escrow.resolveDispute(taskId, releaseToWorker) on-chain.
 *
 * **Owner-operated only.** Its sole caller is
 * `scripts/admin/verify-escrow-lifecycle.ts`, run by hand with the KMS key that owns
 * the escrow (`CC-059`). The MCP `resolve_dispute` tool used to call this and was
 * removed under `ADR-0001` D2 — it let the hiring agent direct the owner key to rule on
 * the agent's own dispute. Nothing request-scoped may call this: arbitration has no
 * app or MCP surface until the adjudication tier exists (`ADR-0007`, proposed).
 *
 * CC-081 Defect 3: waits for the receipt before returning. The hash from
 * `writeContract` only proves the transaction was *submitted* — a reorg or a dropped
 * transaction would leave the caller (and the DB update gated on this call) claiming
 * an outcome that never settled. The returned hash is now guaranteed to be that of a
 * confirmed, non-reverted transaction.
 */
export async function resolveDisputeOnChain(
  taskId: `0x${string}`,
  releaseToWorker: boolean,
): Promise<Hash> {
  const escrow = getEscrowAddress();
  const wallet = await getWalletClient();
  const pub = getPublicClient();
  const account = await getPlatformAccount();

  log("info", "signer_resolve_dispute_submit", {
    taskId,
    releaseToWorker,
    escrow,
  });

  const { request } = await pub.simulateContract({
    account,
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "resolveDispute",
    args: [taskId, releaseToWorker],
  });

  const hash = await wallet.writeContract(request);

  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(
      `resolveDispute transaction reverted on-chain: ${hash} (CC-081 Defect 3 — the DB must not record an outcome that never settled)`,
    );
  }

  log("info", "signer_resolve_dispute_confirmed", {
    taskId,
    txHash: receipt.transactionHash,
    blockNumber: Number(receipt.blockNumber),
  });
  return receipt.transactionHash;
}

// expireTaskOnChain was removed here (CC-119). expireTask is agent-only
// (ADR-0001 A1.2), so it reverted NotAgent() from the platform signer every time.
// The refund is the agent's own call — the dashboard Reclaim button, or the
// `reclaim` hint get_task_status returns over MCP. Do not reintroduce a platform
// path to it.

/** Reset cached clients (for testing). */
export function _resetSignerClients(): void {
  _walletClient = null;
  _publicClient = null;
  _account = null;
}
