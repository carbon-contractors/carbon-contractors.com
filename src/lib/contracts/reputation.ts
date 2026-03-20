/**
 * reputation.ts
 * Server-side read-only client for the ReputationStake contract.
 * Uses viem's publicClient to query on-chain stake state.
 *
 * Write operations (stake, unstake) happen client-side via the
 * worker's connected wallet. Slash is called by the platform owner.
 */

import { createPublicClient, http, type Address } from "viem";
import { baseSepolia, base } from "viem/chains";
import { REPUTATION_STAKE_ABI } from "./reputation-abi";
import { getConfig } from "@/lib/config";

// ── Lazy-initialized client ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicClient: any = null;

function getPublicClient() {
  if (_publicClient) return _publicClient;
  const config = getConfig();
  const chain = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  const rpcUrl = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet"
    ? (config.BASE_MAINNET_RPC_URL ?? chain.rpcUrls.default.http[0])
    : (config.BASE_SEPOLIA_RPC_URL ?? chain.rpcUrls.default.http[0]);
  _publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  return _publicClient;
}

function getStakeAddr(): Address | undefined {
  return getConfig().NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT as Address | undefined;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorkerStake {
  amount: bigint;
  stakedAt: bigint;
  slashedTotal: bigint;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getStakeAddress(): Address {
  const addr = getStakeAddr();
  if (!addr) {
    throw new Error(
      "NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT not set. Deploy the contract first."
    );
  }
  return addr;
}

// ── Read functions ──────────────────────────────────────────────────────────

/**
 * Read a worker's on-chain stake info.
 */
export async function getWorkerStake(wallet: string): Promise<WorkerStake> {
  const result = await getPublicClient().readContract({
    address: getStakeAddress(),
    abi: REPUTATION_STAKE_ABI,
    functionName: "getStake",
    args: [wallet as Address],
  });

  return {
    amount: result[0],
    stakedAt: result[1],
    slashedTotal: result[2],
  };
}

/**
 * Get total USDC staked across all workers.
 */
export async function getTotalStaked(): Promise<bigint> {
  return getPublicClient().readContract({
    address: getStakeAddress(),
    abi: REPUTATION_STAKE_ABI,
    functionName: "totalStaked",
  });
}

/**
 * Get the current minimum stake amount.
 */
export async function getMinStake(): Promise<bigint> {
  return getPublicClient().readContract({
    address: getStakeAddress(),
    abi: REPUTATION_STAKE_ABI,
    functionName: "minStake",
  });
}

/**
 * Get the cooldown period in seconds.
 */
export async function getCooldownPeriod(): Promise<bigint> {
  return getPublicClient().readContract({
    address: getStakeAddress(),
    abi: REPUTATION_STAKE_ABI,
    functionName: "COOLDOWN",
  });
}

/**
 * Get the reputation stake contract config for client-side use.
 */
export function getReputationStakeConfig() {
  const config = getConfig();
  const chain = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  return {
    address: (config.NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT as Address) ?? null,
    chainId: chain.id,
    chainName: chain.name,
    usdcDecimals: 6,
    minStakeUsdc: 20,
    cooldownDays: 7,
  };
}
