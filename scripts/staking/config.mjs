/**
 * config.mjs — env + constants validation for the CC-072 staking harness.
 *
 * Pure module, no side effects, no network — unit-tested from
 * scripts/staking/__tests__/staking-harness.test.mjs. The CLI entry
 * (stake-lifecycle.mjs) self-executes on import, so everything testable
 * lives here instead (same precedent as scripts/lifecycle/config.mjs).
 *
 * Design rules this exists to enforce (inherited from the CC-077 harness):
 *
 *  - Fail once, listing EVERY missing item — an operator walked through
 *    config one missing var at a time has already wasted an evening.
 *  - Blank is not unset (CC-097): `VAR=` arrives as "" and must read as
 *    missing, not as configured.
 *  - The stake contract + USDC + chain id come from chain-constants.json
 *    (networks.base-sepolia.reputationStake / .usdc) — never from env,
 *    never re-derived, never hard-coded here. That file is a record of a
 *    verified deployment; a second copy in a script is how addresses drift.
 *  - The worker key is NEVER returned, logged, or printed. Validation checks
 *    the name's presence and format only; the value stays in process.env and
 *    is read solely by the --execute runner at the moment of use.
 *
 * The worker wallet env var is WORKER_WALLET_PRIVATE_KEY — a NEW name, on
 * purpose, same reasoning as AGENT_WALLET_PRIVATE_KEY (CC-077): the stake
 * flow belongs to the worker, msg.sender IS the staker, and reusing
 * DEPLOYER_PRIVATE_KEY would make the platform's own deployer EOA the
 * on-chain worker — the exact role conflation CC-081 Defect 1 exists to
 * prevent, re-enacted one contract over.
 *
 * CC-072 additionally asks for BOTH wallet architectures to be exercised
 * ("a real Base Account and an EOA, since they're architecturally different
 * enough that one working doesn't guarantee the other does"). The harness
 * drives the EOA leg; the Smart Wallet leg is a browser-only passkey flow
 * and stays a human step, documented in README.md.
 */

import { readFileSync } from "node:fs";

/** Env var names — documented in scripts/staking/README.md and .env.example. */
export const ENV_NAMES = {
  rpcUrl: "BASE_SEPOLIA_RPC_URL",
  workerKey: "WORKER_WALLET_PRIVATE_KEY",
  baseUrl: "NEXT_PUBLIC_BASE_URL",
  network: "NEXT_PUBLIC_BASE_NETWORK",
};

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Known platform-role addresses this harness must refuse to stake from.
 * Staking as the contract owner or a platform deployer would conflate the
 * worker role with the platform role in the very record this ticket exists
 * to produce. Addresses are public on-chain identities (chain-constants.json
 * owner block, CC-090 rehearsal records) — not secrets.
 *
 * Checked against the DERIVED address, never the key material.
 */
export const FORBIDDEN_STAKERS = [
  "0xa8931097540e69b474013d294d0ba6a2cc853e4b", // ReputationStake owner (HSM key)
  "0x7863a5c4396e7aaac2e99cb649a7aa4f6a36b91b", // original pre-HSM deployer EOA (CC-059)
  "0x4c0aae484689fd363cbac4b67f39aad19ed9467f", // CC-090 testnet-only deployer EOA
];

/**
 * Read chain-constants.json and return the staking deployment facts.
 *
 * @returns {{ stake: string, usdc: string, usdcDecimals: number, chainId: number }}
 * @throws if the constants file has no recorded ReputationStake address —
 *         which would mean the deployment record is unfilled (it was null
 *         until CC-072's 2026-09-16 recovery pass) or wrong, and either way
 *         the harness must not guess.
 */
export function loadStakeConstants(constantsJson) {
  const parsed = JSON.parse(constantsJson);
  const net = parsed?.networks?.["base-sepolia"];
  if (!net?.reputationStake?.address || !net?.usdc?.address) {
    throw new Error(
      "chain-constants.json has no base-sepolia reputationStake/usdc deployment " +
        "recorded. The harness refuses to guess addresses — recover the deployed " +
        "address (it lives in the Vercel env and .github/workflows/monitors.yml) " +
        "and record it in networks.base-sepolia.reputationStake.address first.",
    );
  }
  return {
    stake: net.reputationStake.address,
    usdc: net.usdc.address,
    usdcDecimals: net.usdc.decimals,
    chainId: net.chainId,
  };
}

function readConstants() {
  // <repo>/scripts/staking/config.mjs → <repo>/chain-constants.json
  return loadStakeConstants(
    readFileSync(new URL("../../chain-constants.json", import.meta.url), "utf8"),
  );
}

/**
 * Validate every input the harness needs. Collects ALL problems before
 * reporting — one shot, not a scavenger hunt.
 *
 * @param {Record<string, string|undefined>} env — usually process.env; passed in
 *   so tests can drive it without touching (or trusting) the real environment.
 * @param {{ constants?: ReturnType<typeof loadStakeConstants> }} [opts]
 * @returns {{ ok: boolean, problems: string[], config: object|null }}
 *   `problems` are operator-readable sentences, one per defect. `config` is
 *   null when !ok; on success it carries everything except the private key.
 */
export function validateStakingConfig(env, opts = {}) {
  const problems = [];
  const constants = opts.constants ?? readConstants();

  const rpcUrl = env[ENV_NAMES.rpcUrl]?.trim();
  if (!rpcUrl) {
    problems.push(
      `${ENV_NAMES.rpcUrl} is not set. A DEDICATED endpoint, not the public gateway — see CC-048; the public endpoint's rate limit and read-your-writes lag are what make live runs flaky (Lessons-Learned §16).`,
    );
  } else if (!HTTP_URL_RE.test(rpcUrl)) {
    problems.push(`${ENV_NAMES.rpcUrl} is not an http(s) URL: got "${rpcUrl}"`);
  }

  // Presence and FORMAT only. The value is deliberately not captured.
  const workerKey = env[ENV_NAMES.workerKey]?.trim();
  if (!workerKey) {
    problems.push(
      `${ENV_NAMES.workerKey} is not set. A TESTNET-ONLY worker wallet key (0x + 64 hex). It must NOT be DEPLOYER_PRIVATE_KEY or any platform key — the staker IS the worker (see README.md, same rule as CC-077's agent wallet).`,
    );
  } else if (!PRIVATE_KEY_RE.test(workerKey)) {
    problems.push(
      `${ENV_NAMES.workerKey} is malformed — expected 0x followed by 64 hex characters. The value is never printed; only its shape is checked.`,
    );
  }

  const baseUrl = env[ENV_NAMES.baseUrl]?.trim();
  if (!baseUrl) {
    problems.push(
      `${ENV_NAMES.baseUrl} is not set. The harness reads /api/reputation?wallet=… to prove the dashboard's own data path reflects the stake (CC-072 acceptance step 2). /api/* bypasses the coming-soon gate, so the production URL works.`,
    );
  } else if (!HTTP_URL_RE.test(baseUrl)) {
    problems.push(`${ENV_NAMES.baseUrl} is not an http(s) URL: got "${baseUrl}"`);
  }

  // chain-constants pins this harness to base-sepolia; a mainnet-flavoured
  // environment would still read sepolia constants below and quietly aim a
  // funded wallet at the wrong chain's addresses.
  const network = env[ENV_NAMES.network]?.trim();
  if (network && network !== "testnet") {
    problems.push(
      `${ENV_NAMES.network} is "${network}" but this harness is pinned to base-sepolia (chain-constants.json). CC-072 proves the flow on Sepolia; mainnet is CC-034 and is not deployed.`,
    );
  }

  if (problems.length > 0) return { ok: false, problems, config: null };

  return {
    ok: true,
    problems: [],
    config: {
      rpcUrl,
      baseUrl: baseUrl.replace(/\/+$/, ""), // trailing slash would double up in path joins
      workerKeyEnvName: ENV_NAMES.workerKey,
      stake: constants.stake,
      usdc: constants.usdc,
      usdcDecimals: constants.usdcDecimals,
      chainId: constants.chainId,
    },
  };
}

/**
 * The operator-facing failure message — every problem, numbered, plus the
 * pointer to the README. Kept as a function so tests can assert on the shape
 * without duplicating the wording.
 */
export function configFailureMessage(problems) {
  const lines = [
    "MISCONFIGURED — the staking harness cannot run. All problems:",
    "",
    ...problems.map((p, i) => `${i + 1}. ${p}`),
    "",
    "See scripts/staking/README.md (Prerequisites).",
  ];
  return lines.join("\n");
}

/**
 * Expected reputation math for a first stake on a task-less wallet, from
 * src/lib/reputation/compute.ts. Exported so the harness and its tests share
 * one definition of "the score actually reflects the stake" (CC-072 Fix step 2
 * — the acceptance is the DB/API view, not just the chain view).
 *
 * stake component: log2(amount/10 + 1) * 5, clamped to 20.
 * total for a task-less wallet with stake >= 20: clamp(round(stake + 5), 0, 25).
 */
export function expectedReputationForStake(amountUsdc) {
  const stakeComponent = Math.min(
    20,
    Math.max(0, Math.log2(amountUsdc / 10 + 1) * 5),
  );
  const total = Math.min(25, Math.max(0, Math.round(stakeComponent + 5)));
  return { stake: Math.round(stakeComponent), total };
}
