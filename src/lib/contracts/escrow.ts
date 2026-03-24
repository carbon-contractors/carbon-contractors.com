/**
 * escrow.ts
 * Server-side read-only client for the CarbonEscrow contract.
 * Uses viem's publicClient to query on-chain task state.
 *
 * Write operations (createTask, completeTask, etc.) happen client-side
 * via the worker's connected wallet or server-side via the platform signer
 * (see signer.ts).
 */

import { createPublicClient, http, keccak256, toHex, parseAbiItem, type Address } from "viem";
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

// ── Event queries (on-chain reputation) ─────────────────────────────────────

const USDC_DECIMALS = 6;

/**
 * Fetch all TaskCreated events for a given worker address.
 * Returns the set of taskIds assigned to this worker.
 */
async function getTaskIdsForWorker(
  worker: Address,
  fromBlock: bigint = BigInt(0),
): Promise<`0x${string}`[]> {
  const logs = await getPublicClient().getLogs({
    address: getEscrowAddress(),
    event: parseAbiItem(
      "event TaskCreated(bytes32 indexed taskId, address indexed agent, address indexed worker, uint256 amount, uint256 deadline)"
    ),
    args: { worker },
    fromBlock,
    toBlock: "latest",
  });
  return logs.map((l: { args: { taskId: `0x${string}` } }) => l.args.taskId);
}

/**
 * Query on-chain escrow events to build a reputation summary for a worker.
 * No DB dependency — purely reads contract event logs.
 */
export async function getOnChainReputationSummary(
  wallet: string,
  fromBlock: bigint = BigInt(0),
): Promise<{
  total_tasks: number;
  completed: number;
  disputed: number;
  expired: number;
  funded: number;
  total_earned_usdc: number;
  recentCompletions: number;
  midCompletions: number;
}> {
  const escrow = getEscrowAddress();
  const pub = getPublicClient();
  const workerAddr = wallet as Address;

  // Step 1: Get all tasks assigned to this worker
  const taskIds = await getTaskIdsForWorker(workerAddr, fromBlock);
  if (taskIds.length === 0) {
    return {
      total_tasks: 0,
      completed: 0,
      disputed: 0,
      expired: 0,
      funded: 0,
      total_earned_usdc: 0,
      recentCompletions: 0,
      midCompletions: 0,
    };
  }

  // Step 2: Fetch completion, dispute, and expiry events in parallel
  const [completedLogs, disputedLogs, expiredLogs] = await Promise.all([
    pub.getLogs({
      address: escrow,
      event: parseAbiItem(
        "event TaskCompleted(bytes32 indexed taskId, uint256 amount)"
      ),
      fromBlock,
      toBlock: "latest",
    }),
    pub.getLogs({
      address: escrow,
      event: parseAbiItem(
        "event TaskDisputed(bytes32 indexed taskId, address by)"
      ),
      fromBlock,
      toBlock: "latest",
    }),
    pub.getLogs({
      address: escrow,
      event: parseAbiItem(
        "event TaskExpired(bytes32 indexed taskId, uint256 refunded)"
      ),
      fromBlock,
      toBlock: "latest",
    }),
  ]);

  // Build sets of taskIds that belong to this worker
  const workerTaskSet = new Set(taskIds.map((id) => id.toLowerCase()));

  // Filter events to only this worker's tasks
  const completions = completedLogs.filter(
    (l: { args: { taskId: string } }) => workerTaskSet.has(l.args.taskId.toLowerCase()),
  );
  const disputes = disputedLogs.filter(
    (l: { args: { taskId: string } }) => workerTaskSet.has(l.args.taskId.toLowerCase()),
  );
  const expiries = expiredLogs.filter(
    (l: { args: { taskId: string } }) => workerTaskSet.has(l.args.taskId.toLowerCase()),
  );

  // Step 3: Calculate earned USDC and recency from block timestamps
  const now = Math.floor(Date.now() / 1000);
  const thirtyDays = 30 * 24 * 60 * 60;
  const ninetyDays = 90 * 24 * 60 * 60;

  let totalEarnedUsdc = 0;
  let recentCompletions = 0;
  let midCompletions = 0;

  for (const log of completions) {
    const amount = Number(log.args.amount) / 10 ** USDC_DECIMALS;
    totalEarnedUsdc += amount;

    // Get block timestamp for recency scoring
    if (log.blockNumber) {
      try {
        const block = await pub.getBlock({ blockNumber: log.blockNumber });
        const age = now - Number(block.timestamp);
        if (age <= thirtyDays) recentCompletions++;
        else if (age <= ninetyDays) midCompletions++;
      } catch {
        // If we can't get timestamp, don't count for recency
      }
    }
  }

  const completed = completions.length;
  const disputed = disputes.length;
  const expired = expiries.length;
  const funded = taskIds.length - completed - disputed - expired;

  return {
    total_tasks: taskIds.length,
    completed,
    disputed,
    expired,
    funded: Math.max(0, funded),
    total_earned_usdc: totalEarnedUsdc,
    recentCompletions,
    midCompletions,
  };
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
