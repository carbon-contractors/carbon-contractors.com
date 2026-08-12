/**
 * reputation/index.ts
 * Compositor — combines on-chain task state, on-chain stake, and computed score.
 *
 * The escrow contract is the source of truth for every fact about money: task state,
 * amount, and which worker a task belongs to. The DB supplies only the *list* of
 * candidate payment_request_ids to verify, plus timestamps for recency weighting —
 * neither of which can misstate an outcome, because each id's state is read from the
 * chain and its worker address re-checked. See CC-070 for why discovery moved off
 * event logs, and getOnChainReputationSummary for the trade-offs.
 *
 * Falls back entirely to the DB if the escrow contract is not deployed, or if the
 * on-chain read fails — in which case `source` reports "database" so the caller can
 * tell the difference.
 */

import { getReputationSummary, getTasksByWallet } from "@/lib/db/tasks";
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
      // CC-070: the DB proposes which tasks to check; the chain decides what is true
      // about each one. Discovery used to come from TaskCreated events, but that query
      // exceeded the RPC's block-range cap on every call, so this path silently fell
      // back to the DB for the whole life of the project. See the long note on
      // getOnChainReputationSummary for why discovery and authority are now separate.
      const dbTasks = await getTasksByWallet(wallet);
      const onChain = await getOnChainReputationSummary(
        wallet,
        dbTasks.map((t) => t.payment_request_id),
      );

      // Recency is scored from DB timestamps, over only those completions the chain
      // confirmed. getTask() carries no timestamp, and fetching a block per completion
      // would undo the single-round-trip win. Soft ordering from the DB, money facts
      // from the chain.
      const createdAtById = new Map(
        dbTasks.map((t) => [t.payment_request_id, new Date(t.created_at).getTime()]),
      );
      const now = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

      let recentCompletions = 0;
      let midCompletions = 0;
      for (const id of onChain.completedPaymentRequestIds) {
        const createdAt = createdAtById.get(id);
        if (createdAt === undefined) continue;
        const age = now - createdAt;
        if (age <= thirtyDaysMs) recentCompletions++;
        else if (age <= ninetyDaysMs) midCompletions++;
      }

      taskSummary = {
        total_tasks: onChain.total_tasks,
        completed: onChain.completed,
        // An arbitrated dispute is still a dispute that happened, so `Resolved` counts
        // toward the worker's dispute history for scoring purposes. It is tracked
        // separately on-chain because the state alone does not reveal which way it went.
        disputed: onChain.disputed + onChain.resolved,
        expired: onChain.expired,
        active: onChain.funded, // funded tasks are active on-chain
        pending: 0, // pending is a DB-only concept (pre-funding)
        total_earned_usdc: onChain.total_earned_usdc,
        recentCompletions,
        midCompletions,
      };
      source = "on-chain";
      log("info", "reputation_source_onchain", {
        wallet: wallet.slice(0, 10),
        offered: dbTasks.length,
        verified: onChain.total_tasks,
        unverified: onChain.unverified.length,
      });
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
