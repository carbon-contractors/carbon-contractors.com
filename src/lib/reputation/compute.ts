/**
 * compute.ts
 * Pure reputation scoring function. Score 0-100.
 *
 * Components:
 *   Completion ratio:  0-40 pts (penalizes disputes)
 *   Volume bonus:      0-20 pts (logarithmic scale)
 *   Recency:           0-20 pts (recent activity weighted heavily)
 *   Stake multiplier:  0-20 pts (logarithmic scale)
 */

export interface ReputationInput {
  completed: number;
  disputed: number;
  totalTasks: number;
  stakeAmountUsdc: number;
  recentCompletions: number; // last 30 days
  midCompletions: number; // 30-90 days ago
}

export interface ReputationBreakdown {
  completion: number;
  volume: number;
  recency: number;
  stake: number;
  total: number;
}

/**
 * A worker is "new" until they have any history at all — a task or a stake. The
 * dashboard shows a "New — no history yet" state for these workers rather than the
 * bare 0 that computeReputation returns (CC-010).
 *
 * Source-of-truth note (CC-010 triage): the computed score is the only reputation
 * number the worker ever sees. The `reputation_score` column the register route seeds
 * with 50 is an MCP search-ranking seed only — see the CC-010 completion notes.
 */
export function isNewWorker(input: {
  totalTasks: number;
  stakeAmountUsdc: number;
}): boolean {
  return input.totalTasks === 0 && input.stakeAmountUsdc <= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeReputation(input: ReputationInput): ReputationBreakdown {
  const {
    completed,
    disputed,
    totalTasks,
    stakeAmountUsdc,
    recentCompletions,
    midCompletions,
  } = input;

  // Component 1: Completion ratio (0-40 pts)
  let completion = 0;
  if (totalTasks > 0) {
    const completionRate = completed / totalTasks;
    const disputePenalty = (disputed / totalTasks) * 2;
    completion = clamp((completionRate - disputePenalty) * 40, 0, 40);
  }

  // Component 2: Volume bonus (0-20 pts, logarithmic)
  // 1 task ≈ 5, 5 tasks ≈ 13, 20 tasks ≈ 22 → capped at 20
  const volume = clamp(Math.log2(completed + 1) * 5, 0, 20);

  // Component 3: Recency (0-20 pts)
  // Recent completions (30 days) worth 4 pts each, mid (30-90 days) worth 1 pt
  const recency = clamp(recentCompletions * 4 + midCompletions * 1, 0, 20);

  // Component 4: Stake multiplier (0-20 pts, logarithmic)
  // $20 ≈ 5, $50 ≈ 10, $100 ≈ 15, $200+ ≈ 20
  const stake =
    stakeAmountUsdc > 0
      ? clamp(Math.log2(stakeAmountUsdc / 10 + 1) * 5, 0, 20)
      : 0;

  // New workers with stake but no tasks get a floor score
  if (totalTasks === 0 && stakeAmountUsdc >= 20) {
    const floor = clamp(Math.round(stake + 5), 0, 25);
    return {
      completion: 0,
      volume: 0,
      recency: 0,
      stake: Math.round(stake),
      total: floor,
    };
  }

  const total = Math.round(
    clamp(completion + volume + recency + stake, 0, 100)
  );

  return {
    completion: Math.round(completion),
    volume: Math.round(volume),
    recency: Math.round(recency),
    stake: Math.round(stake),
    total,
  };
}
