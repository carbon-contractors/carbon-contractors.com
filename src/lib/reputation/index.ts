/**
 * reputation/index.ts
 * Compositor — combines on-chain task events, on-chain stake, and computed score.
 * Primary source of truth is the escrow contract event logs (no DB dependency
 * for reputation). Falls back to DB if the escrow contract is not deployed.
 */

import { getReputationSummary } from "@/lib/db/tasks";
import { getWorkerStake, getReputationStakeConfig } from "@/lib/contracts/reputation";
import { getOnChainReputationSummary, getEscrowConfig } from "@/lib/contracts/escrow";
import { computeReputation, type ReputationBreakdown } from "./compute";
import { log } from "@/lib/logging";

const USDC_DECIMALS = 6;

export interface FullReputation {
  wallet: string;
  score: number;
  breakdown: ReputationBreakdown;
  source: "on-chain" | "database";
  tasks: {
    total: number;
    completed: number;
    disputed: number;
    expired: number;
    active: number;
    pending: number;
    total_earned_usdc: number;
    completion_rate: number | null;
  };
  stake: {
    amount_usdc: number;
    staked_at: number;
    slashed_total_usdc: number;
    contract: string | null;
  };
}

export async function getFullReputation(wallet: string): Promise<FullReputation> {
  // Try on-chain events first (trustless), fall back to DB
  let taskSummary: {
    total_tasks: number;
    completed: number;
    disputed: number;
    expired: number;
    active: number;
    pending: number;
    total_earned_usdc: number;
    recentCompletions: number;
    midCompletions: number;
  };
  let source: "on-chain" | "database" = "database";

  const escrowConfig = getEscrowConfig();
  if (escrowConfig.address) {
    try {
      const onChain = await getOnChainReputationSummary(wallet);
      taskSummary = {
        ...onChain,
        active: onChain.funded, // funded tasks are active on-chain
        pending: 0, // pending is a DB-only concept (pre-funding)
      };
      source = "on-chain";
      log("info", "reputation_source_onchain", { wallet: wallet.slice(0, 10) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", "reputation_onchain_fallback", { wallet: wallet.slice(0, 10), error: msg });
      const dbSummary = await getReputationSummary(wallet);
      taskSummary = dbSummary;
    }
  } else {
    const dbSummary = await getReputationSummary(wallet);
    taskSummary = dbSummary;
  }

  // On-chain stake (always from ReputationStake contract)
  let stakeAmountUsdc = 0;
  let stakedAt = 0;
  let slashedTotalUsdc = 0;
  const stakeConfig = getReputationStakeConfig();

  if (stakeConfig.address) {
    try {
      const onChainStake = await getWorkerStake(wallet);
      stakeAmountUsdc =
        Number(onChainStake.amount) / 10 ** USDC_DECIMALS;
      stakedAt = Number(onChainStake.stakedAt);
      slashedTotalUsdc =
        Number(onChainStake.slashedTotal) / 10 ** USDC_DECIMALS;
    } catch {
      // Contract not deployed or wallet has no stake — use defaults
    }
  }

  const breakdown = computeReputation({
    completed: taskSummary.completed,
    disputed: taskSummary.disputed,
    totalTasks: taskSummary.total_tasks,
    stakeAmountUsdc,
    recentCompletions: taskSummary.recentCompletions,
    midCompletions: taskSummary.midCompletions,
  });

  return {
    wallet,
    score: breakdown.total,
    breakdown,
    source,
    tasks: {
      total: taskSummary.total_tasks,
      completed: taskSummary.completed,
      disputed: taskSummary.disputed,
      expired: taskSummary.expired,
      active: taskSummary.active,
      pending: taskSummary.pending,
      total_earned_usdc: taskSummary.total_earned_usdc,
      completion_rate:
        taskSummary.total_tasks > 0
          ? Math.round((taskSummary.completed / taskSummary.total_tasks) * 100)
          : null,
    },
    stake: {
      amount_usdc: stakeAmountUsdc,
      staked_at: stakedAt,
      slashed_total_usdc: slashedTotalUsdc,
      contract: stakeConfig.address,
    },
  };
}
