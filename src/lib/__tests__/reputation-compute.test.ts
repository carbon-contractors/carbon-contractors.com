import { describe, it, expect } from "vitest";
import {
  computeReputation,
  isNewWorker,
  type ReputationInput,
} from "@/lib/reputation/compute";

function makeInput(overrides: Partial<ReputationInput> = {}): ReputationInput {
  return {
    completed: 0,
    disputed: 0,
    totalTasks: 0,
    stakeAmountUsdc: 0,
    recentCompletions: 0,
    midCompletions: 0,
    ...overrides,
  };
}

describe("computeReputation", () => {
  it("returns 0 for a brand new worker with no stake", () => {
    const result = computeReputation(makeInput());
    expect(result.total).toBe(0);
    expect(result.completion).toBe(0);
    expect(result.volume).toBe(0);
    expect(result.recency).toBe(0);
    expect(result.stake).toBe(0);
  });

  it("gives floor score for new worker with stake but no tasks", () => {
    const result = computeReputation(makeInput({ stakeAmountUsdc: 20 }));
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThanOrEqual(25);
    expect(result.completion).toBe(0);
    expect(result.volume).toBe(0);
  });

  it("scores perfect completion highly", () => {
    const result = computeReputation(
      makeInput({
        completed: 10,
        totalTasks: 10,
        recentCompletions: 5,
        midCompletions: 5,
      })
    );
    expect(result.completion).toBe(40); // max completion
    expect(result.total).toBeGreaterThan(60);
  });

  it("penalizes disputes", () => {
    const clean = computeReputation(
      makeInput({ completed: 8, totalTasks: 10, recentCompletions: 5 })
    );
    const disputed = computeReputation(
      makeInput({
        completed: 8,
        disputed: 2,
        totalTasks: 10,
        recentCompletions: 5,
      })
    );
    expect(disputed.completion).toBeLessThan(clean.completion);
    expect(disputed.total).toBeLessThan(clean.total);
  });

  it("scales volume logarithmically", () => {
    const one = computeReputation(makeInput({ completed: 1, totalTasks: 1 }));
    const twenty = computeReputation(makeInput({ completed: 20, totalTasks: 20 }));
    expect(twenty.volume).toBeGreaterThan(one.volume);
    expect(twenty.volume).toBe(20); // capped at 20
  });

  it("weighs recent completions more heavily than mid-range", () => {
    const recent = computeReputation(
      makeInput({
        completed: 5,
        totalTasks: 5,
        recentCompletions: 5,
        midCompletions: 0,
      })
    );
    const mid = computeReputation(
      makeInput({
        completed: 5,
        totalTasks: 5,
        recentCompletions: 0,
        midCompletions: 5,
      })
    );
    expect(recent.recency).toBeGreaterThan(mid.recency);
  });

  it("scales stake bonus logarithmically", () => {
    const low = computeReputation(makeInput({ stakeAmountUsdc: 20, completed: 1, totalTasks: 1 }));
    const high = computeReputation(makeInput({ stakeAmountUsdc: 200, completed: 1, totalTasks: 1 }));
    expect(high.stake).toBeGreaterThan(low.stake);
    expect(high.stake).toBeLessThanOrEqual(20);
  });

  it("clamps total to 100", () => {
    const result = computeReputation(
      makeInput({
        completed: 100,
        totalTasks: 100,
        stakeAmountUsdc: 500,
        recentCompletions: 50,
        midCompletions: 50,
      })
    );
    expect(result.total).toBeLessThanOrEqual(100);
  });
});

describe("isNewWorker (CC-010)", () => {
  it("is new with no tasks and no stake — the dashboard shows a state, not a 0", () => {
    expect(isNewWorker({ totalTasks: 0, stakeAmountUsdc: 0 })).toBe(true);
  });

  it("is not new once a task exists, whatever its outcome", () => {
    expect(isNewWorker({ totalTasks: 1, stakeAmountUsdc: 0 })).toBe(false);
  });

  it("is not new once staked — a stake earns the floor score without tasks", () => {
    expect(isNewWorker({ totalTasks: 0, stakeAmountUsdc: 20 })).toBe(false);
  });

  it("agrees with the compute path: for workers with only history worth scoring, new is exactly the zero-score case", () => {
    // Note this does NOT hold in general — a worker whose tasks all expired or
    // disputed has history and a genuine 0, which is a score, not a "new" state.
    for (const [totalTasks, stakeAmountUsdc] of [
      [0, 0],
      [0, 20],
      [1, 0],
      [3, 50],
    ] as const) {
      const input = makeInput({
        totalTasks,
        stakeAmountUsdc,
        completed: totalTasks,
      });
      const scored = computeReputation(input).total > 0;
      expect(isNewWorker(input)).toBe(!scored);
    }
  });
});
