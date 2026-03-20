/**
 * escrow.ts
 * Server-side read-only client for the CarbonEscrow contract.
 * Uses viem's publicClient to query on-chain task state.
 *
 * Write operations (createTask, completeTask, etc.) happen client-side
 * via the worker's connected wallet or server-side via AgentKit (Phase 4).
 */

import { createPublicClient, http, keccak256, toHex, type Address } from "viem";
import { baseSepolia, base } from "viem/chains";
import { CARBON_ESCROW_ABI } from "./escrow-abi";
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

function getEscrowAddr(): Address | undefined {
  return getConfig().NEXT_PUBLIC_ESCROW_CONTRACT as Address | undefined;
}

// ── Task state enum (mirrors Solidity) ──────────────────────────────────────

export const TaskStateEnum = {
  0: "None",
  1: "Funded",
  2: "Completed",
  3: "Disputed",
  4: "Resolved",
  5: "Expired",
} as const;

export type OnChainTaskState =
  (typeof TaskStateEnum)[keyof typeof TaskStateEnum];

export interface OnChainTask {
  agent: Address;
  worker: Address;
  amount: bigint;
  deadline: bigint;
  state: OnChainTaskState;
  stateRaw: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a payment_request_id string to the bytes32 taskId used on-chain.
 */
export function toTaskId(paymentRequestId: string): `0x${string}` {
  return keccak256(toHex(paymentRequestId));
}

function getEscrowAddress(): Address {
  const addr = getEscrowAddr();
  if (!addr) {
    throw new Error(
      "NEXT_PUBLIC_ESCROW_CONTRACT not set. Deploy the contract first."
    );
  }
  return addr;
}

// ── Read functions ──────────────────────────────────────────────────────────

/**
 * Read a task's on-chain state from the escrow contract.
 */
export async function getOnChainTask(
  paymentRequestId: string
): Promise<OnChainTask> {
  const taskId = toTaskId(paymentRequestId);
  const result = await getPublicClient().readContract({
    address: getEscrowAddress(),
    abi: CARBON_ESCROW_ABI,
    functionName: "getTask",
    args: [taskId],
  });

  const [agent, worker, amount, deadline, stateRaw] = [
    result.agent,
    result.worker,
    result.amount,
    result.deadline,
    Number(result.state),
  ];

  return {
    agent: agent as Address,
    worker: worker as Address,
    amount,
    deadline,
    state: TaskStateEnum[stateRaw as keyof typeof TaskStateEnum] ?? "None",
    stateRaw,
  };
}

/**
 * Get total USDC currently locked in the escrow contract.
 */
export async function getTotalLocked(): Promise<bigint> {
  return getPublicClient().readContract({
    address: getEscrowAddress(),
    abi: CARBON_ESCROW_ABI,
    functionName: "totalLocked",
  });
}

/**
 * Get the escrow contract address and chain info for client-side use.
 */
export function getEscrowConfig() {
  const config = getConfig();
  const chain = config.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia;
  return {
    address: (config.NEXT_PUBLIC_ESCROW_CONTRACT as Address) ?? null,
    chainId: chain.id,
    chainName: chain.name,
    usdcDecimals: 6,
  };
}
