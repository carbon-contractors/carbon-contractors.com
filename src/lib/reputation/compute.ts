/**
 * compute.ts
 * Pure reputation scoring function. Score 0-100.
 *
 * Components (ADR-0013: reputation is non-monetary, so there is no stake component):
 *   Completion ratio:  0-50 pts (penalizes disputes)
 *   Volume bonus:      0-25 pts (logarithmic scale)
 *   Recency:           0-25 pts (recent activity weighted heavily)
 */

export interface ReputationInput {
  completed: number;
  disputed: number;
  totalTasks: number;
  recentCompletions: number; // last 30 days
  midCompletions: number; // 30-90 days ago
}

export interface ReputationBreakdown {
  completion: number;
  volume: number;
  recency: number;
  total: number;
}

/**
 * A worker is "new" until they have any task history at all. The
 * dashboard shows a "New — no history yet" state for these workers rather than the
 * bare 0 that computeReputation returns (CC-010).
 *
 * Source-of-truth note (CC-010 triage): the computed score is the only reputation
 * number the worker ever sees. The `reputation_score` column the register route seeds
 * with 50 is an MCP search-ranking seed only — see the CC-010 completion notes.
 */
export function isNewWorker(input: { totalTasks: number }): boolean {
  return input.totalTasks === 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeReputation(input: ReputationInput): ReputationBreakdown {
  const {
    completed,
    disputed,
    totalTasks,
    recentCompletions,
    midCompletions,
  } = input;

  // Component 1: Completion ratio (0-50 pts)
  let completion = 0;
  if (totalTasks > 0) {
    const completionRate = completed / totalTasks;
    const disputePenalty = (disputed / totalTasks) * 2;
    completion = clamp((completionRate - disputePenalty) * 50, 0, 50);
  }

  // Component 2: Volume bonus (0-25 pts, logarithmic)
  // 1 task ≈ 5, 5 tasks ≈ 13, 20 tasks ≈ 22, 31+ tasks → capped at 25
  const volume = clamp(Math.log2(completed + 1) * 5, 0, 25);

  // Component 3: Recency (0-25 pts)
  // Recent completions (30 days) worth 4 pts each, mid (30-90 days) worth 1 pt
  const recency = clamp(recentCompletions * 4 + midCompletions * 1, 0, 25);

  const total = Math.round(
    clamp(completion + volume + recency, 0, 100)
  );

  return {
    completion: Math.round(completion),
    volume: Math.round(volume),
    recency: Math.round(recency),
    total,
  };
}
