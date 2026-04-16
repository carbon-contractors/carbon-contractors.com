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

async function getPlatformAccount(): Promise<LocalAccount> {
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

/**
 * Call escrow.completeTask(taskId) on-chain as the platform signer.
 * Releases locked USDC to the worker.
 */
export async function completeTaskOnChain(
  taskId: `0x${string}`,
): Promise<Hash> {
  const escrow = getEscrowAddress();
  const wallet = await getWalletClient();
  const pub = getPublicClient();
  const account = await getPlatformAccount();

  log("info", "signer_complete_task_submit", { taskId, escrow });

  const { request } = await pub.simulateContract({
    account,
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "completeTask",
    args: [taskId],
  });

  const hash = await wallet.writeContract(request);

  log("info", "signer_complete_task_sent", { taskId, txHash: hash });
  return hash;
}

/**
 * Call escrow.resolveDispute(taskId, releaseToWorker) on-chain.
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

  log("info", "signer_resolve_dispute_sent", { taskId, txHash: hash });
  return hash;
}

/**
 * Call escrow.expireTask(taskId) on-chain to refund the agent.
 */
export async function expireTaskOnChain(
  taskId: `0x${string}`,
): Promise<Hash> {
  const escrow = getEscrowAddress();
  const wallet = await getWalletClient();
  const pub = getPublicClient();
  const account = await getPlatformAccount();

  log("info", "signer_expire_task_submit", { taskId, escrow });

  const { request } = await pub.simulateContract({
    account,
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "expireTask",
    args: [taskId],
  });

  const hash = await wallet.writeContract(request);

  log("info", "signer_expire_task_sent", { taskId, txHash: hash });
  return hash;
}

/** Reset cached clients (for testing). */
export function _resetSignerClients(): void {
  _walletClient = null;
  _publicClient = null;
  _account = null;
}
