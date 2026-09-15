/**
 * staking-harness.test.mjs — unit tests for the CC-072 staking harness config
 * module. Pure and hermetic (vitest.setup.ts strips env and blocks fetch) —
 * the chain legs are exercised by --execute runs, not here.
 */

import { describe, it, expect } from "vitest";
import {
  loadStakeConstants,
  validateStakingConfig,
  configFailureMessage,
  expectedReputationForStake,
  FORBIDDEN_STAKERS,
} from "../config.mjs";

const STAKE = "0x4cdeF542F9361201f9543512eeCd1eE834793203";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function constantsFixture({ stake = STAKE } = {}) {
  return JSON.stringify({
    networks: {
      "base-sepolia": {
        chainId: 84532,
        escrow: { address: "0xc6aa99a8226b679C71945dd9545685896a91E4d3", deployBlock: 46227900 },
        reputationStake: { address: stake },
        usdc: { address: USDC, decimals: 6 },
      },
    },
  });
}

const GOOD_ENV = {
  BASE_SEPOLIA_RPC_URL: "https://base-sepolia.example.rpc",
  WORKER_WALLET_PRIVATE_KEY: "0x" + "a".repeat(64),
  NEXT_PUBLIC_BASE_URL: "https://www.carbon-contractors.com/",
  NEXT_PUBLIC_BASE_NETWORK: "testnet",
};

describe("loadStakeConstants", () => {
  it("reads the stake deployment from chain-constants.json", () => {
    const c = loadStakeConstants(constantsFixture());
    expect(c.stake).toBe(STAKE);
    expect(c.usdc).toBe(USDC);
    expect(c.usdcDecimals).toBe(6);
    expect(c.chainId).toBe(84532);
  });

  it("refuses to guess when reputationStake.address is unrecorded (null)", () => {
    // The exact state chain-constants.json was in before the CC-072 recovery
    // pass — the harness must name the problem, not invent an address.
    expect(() => loadStakeConstants(constantsFixture({ stake: null }))).toThrow(/no base-sepolia reputationStake/);
  });

  it("refuses to guess when the networks block is missing entirely", () => {
    expect(() => loadStakeConstants("{}")).toThrow(/no base-sepolia reputationStake/);
  });
});

describe("validateStakingConfig", () => {
  it("lists every missing var at once, not one at a time", () => {
    const r = validateStakingConfig({}, { constants: loadStakeConstants(constantsFixture()) });
    expect(r.ok).toBe(false);
    expect(r.config).toBeNull();
    expect(r.problems).toHaveLength(3);
    expect(r.problems[0]).toContain("BASE_SEPOLIA_RPC_URL");
    expect(r.problems[1]).toContain("WORKER_WALLET_PRIVATE_KEY");
    expect(r.problems[2]).toContain("NEXT_PUBLIC_BASE_URL");
  });

  it("treats blank (VAR=) as unset — CC-097", () => {
    const r = validateStakingConfig(
      { ...GOOD_ENV, WORKER_WALLET_PRIVATE_KEY: "" },
      { constants: loadStakeConstants(constantsFixture()) },
    );
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("WORKER_WALLET_PRIVATE_KEY is not set");
  });

  it("checks key FORMAT only and never captures the value", () => {
    const r = validateStakingConfig(
      { ...GOOD_ENV, WORKER_WALLET_PRIVATE_KEY: "not-a-key" },
      { constants: loadStakeConstants(constantsFixture()) },
    );
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("malformed");
    const ok = validateStakingConfig(GOOD_ENV, { constants: loadStakeConstants(constantsFixture()) });
    expect(ok.ok).toBe(true);
    expect(ok.config.workerKeyEnvName).toBe("WORKER_WALLET_PRIVATE_KEY");
    expect(JSON.stringify(ok.config)).not.toContain("a".repeat(64)); // key material never leaves env
  });

  it("rejects non-http RPC/base URLs", () => {
    for (const [bad, varName] of [
      ["ftp://rpc", "BASE_SEPOLIA_RPC_URL"],
      ["gopher://x", "NEXT_PUBLIC_BASE_URL"],
    ]) {
      const r = validateStakingConfig(
        { ...GOOD_ENV, [varName]: bad },
        { constants: loadStakeConstants(constantsFixture()) },
      );
      expect(r.problems.some((p) => p.includes(varName) && p.includes("not an http(s) URL"))).toBe(true);
    }
  });

  it("strips a trailing slash from the base URL (path joins would double up)", () => {
    const r = validateStakingConfig(GOOD_ENV, { constants: loadStakeConstants(constantsFixture()) });
    expect(r.config.baseUrl).toBe("https://www.carbon-contractors.com");
  });

  it("refuses a mainnet-flavoured environment — the harness is Sepolia-pinned", () => {
    const r = validateStakingConfig(
      { ...GOOD_ENV, NEXT_PUBLIC_BASE_NETWORK: "mainnet" },
      { constants: loadStakeConstants(constantsFixture()) },
    );
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("pinned to base-sepolia");
  });
});

describe("FORBIDDEN_STAKERS", () => {
  it("names the three known platform addresses (owner + both deployer EOAs)", () => {
    expect(FORBIDDEN_STAKERS).toContain("0xa8931097540e69b474013d294d0ba6a2cc853e4b");
    expect(FORBIDDEN_STAKERS).toContain("0x7863a5c4396e7aaac2e99cb649a7aa4f6a36b91b");
    expect(FORBIDDEN_STAKERS).toContain("0x4c0aae484689fd363cbac4b67f39aad19ed9467f");
  });
});

describe("expectedReputationForStake — mirrors compute.ts exactly", () => {
  it("a 20 USDC first stake on a task-less wallet: stake component 8, total floor 13", () => {
    // log2(20/10 + 1) * 5 = log2(3) * 5 ≈ 7.92 → 8; floor = round(7.92 + 5) = 13
    expect(expectedReputationForStake(20)).toEqual({ stake: 8, total: 13 });
  });

  it("capped: a 200 USDC stake maxes the stake component at 20 and the floor at 25", () => {
    expect(expectedReputationForStake(200)).toEqual({ stake: 20, total: 25 });
  });

  it("cross-checks against the real compute.ts implementation", async () => {
    const { computeReputation } = await import("../../../src/lib/reputation/compute.ts");
    for (const amount of [20, 25, 50, 100, 200]) {
      const fromLib = computeReputation({
        completed: 0,
        disputed: 0,
        totalTasks: 0,
        stakeAmountUsdc: amount,
        recentCompletions: 0,
        midCompletions: 0,
      });
      expect(expectedReputationForStake(amount)).toEqual({
        stake: fromLib.stake,
        total: fromLib.total,
      });
    }
  });
});

describe("configFailureMessage", () => {
  it("numbers every problem and points at the README", () => {
    const msg = configFailureMessage(["one", "two"]);
    expect(msg).toContain("1. one");
    expect(msg).toContain("2. two");
    expect(msg).toContain("scripts/staking/README.md");
  });
});
