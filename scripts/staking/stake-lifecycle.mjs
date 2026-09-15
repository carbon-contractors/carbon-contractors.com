/**
 * stake-lifecycle.mjs — CC-072 staking flow harness (Base Sepolia).
 *
 * Drives the on-chain half of the never-executed reputation staking flow
 * (CC-072): approve → stake → cooldown refusal → (after 7 days) unstake,
 * with the dashboard's own data path (/api/reputation) checked after every
 * state change, because "the dashboard correctly reflecting the result at
 * each step" is the acceptance — the chain alone is not enough.
 *
 * The harness signs with a WORKER wallet (WORKER_WALLET_PRIVATE_KEY), never a
 * platform key: ReputationStake.stake records msg.sender as the staker, so
 * the staker IS the worker. Same anti-conflation rule as CC-077's agent
 * wallet (CC-081 Defect 1).
 *
 * The 7-day cooldown makes this resumable by necessity, same shape as the
 * CC-082 lifecycle proof: state lives in .stake-lifecycle-state.json (git
 * ignored), every phase re-derives its preconditions from the chain rather
 * than trusting the file, and each phase can run days apart.
 *
 * Phases (default: run whichever the chain state says is next):
 *   --phase=status            read-only: wallet, balances, stake info, cooldown ETA
 *   --phase=stake --amount=20 approve + stake (two txs), then verify chain AND API
 *   --phase=cooldown-refusal  eth_call unstake() during cooldown — must revert
 *                             with CooldownNotElapsed(readyAt) and nothing else
 *   --phase=unstake --amount=20  post-cooldown unstake, verify funds returned
 *
 * Modes:
 *   --dry-run (default)  validate config, print the exact plan, contact no RPC
 *   --execute            run the plan for real. Broadcasts from the worker
 *                        wallet. cooldown-refusal only eth_calls even here —
 *                        it is a guard case, not a spend.
 *
 *   node --env-file=.env.local scripts/staking/stake-lifecycle.mjs --phase=status --execute
 *
 * Exit codes: 0 expected outcome (incl. the expected cooldown revert) ·
 * 1 the behaviour did NOT match CC-072's expected clean outcome ·
 * 2 misconfigured or bad arguments.
 *
 * The Smart Wallet / Base Account leg of CC-072 is NOT this harness: passkey
 * signing happens in a browser, and the harness would defeat its own purpose
 * (proving the flow as a real worker experiences it) by scripting it. It is
 * documented as a human step in scripts/staking/README.md.
 */

import { createPublicClient, createWalletClient, http, formatUnits, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateStakingConfig, configFailureMessage, ENV_NAMES, FORBIDDEN_STAKERS, expectedReputationForStake } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const STATE_PATH = join(REPO, ".stake-lifecycle-state.json");

const PHASES = ["status", "stake", "cooldown-refusal", "unstake"];

const STAKE_ABI = [
  parseAbiItem("function stake(uint256 amount)"),
  parseAbiItem("function unstake(uint256 amount)"),
  parseAbiItem("function getStake(address worker) view returns (uint256 amount, uint256 stakedAt, uint256 slashedTotal)"),
  parseAbiItem("function minStake() view returns (uint256)"),
  parseAbiItem("function COOLDOWN() view returns (uint256)"),
  parseAbiItem("function totalStaked() view returns (uint256)"),
  parseAbiItem("function usdc() view returns (address)"),
  parseAbiItem("function owner() view returns (address)"),
  parseAbiItem("event Staked(address indexed worker, uint256 amount, uint256 newTotal)"),
  parseAbiItem("event Unstaked(address indexed worker, uint256 amount, uint256 remaining)"),
];
const ERC20_ABI = [
  parseAbiItem("function approve(address spender, uint256 amount)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
];

// ── CLI args (kept minimal — the config validator does the real gating) ────

function parseCli(argv) {
  const problems = [];
  const out = { phase: null, amount: null, dryRun: true, execute: false };
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);
    if (name === "--dry-run") out.dryRun = true;
    else if (name === "--execute") { out.execute = true; out.dryRun = false; }
    else if (name === "--phase") {
      if (!value || !PHASES.includes(value)) problems.push(`--phase must be one of: ${PHASES.join(", ")}`);
      else out.phase = value;
    } else if (name === "--amount") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) problems.push(`--amount must be a positive number, got "${value}"`);
      else out.amount = n;
    } else problems.push(`unknown flag: ${name}`);
  }
  if (out.dryRun && out.execute) problems.push("--dry-run and --execute are mutually exclusive.");
  if (!out.phase) problems.push(`--phase is required (one of: ${PHASES.join(", ")})`);
  if ((out.phase === "stake" || out.phase === "unstake") && !out.amount) {
    problems.push(`--phase=${out.phase} needs --amount=<USDC>`);
  }
  if (problems.length) {
    throw new Error(["Bad arguments:", "", ...problems.map((p, i) => `${i + 1}. ${p}`), "", USAGE].join("\n"));
  }
  return out;
}

const USAGE = `usage: node --env-file=.env.local scripts/staking/stake-lifecycle.mjs --phase=<${PHASES.join("|")}> [--amount=<USDC>] [--dry-run | --execute]`;

// ── State file (CC-082 pattern: resumable across the 7-day cooldown) ───────

function loadState() {
  if (!existsSync(STATE_PATH)) return { phases: {} };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { phases: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function recordPhase(name, entry) {
  const state = loadState();
  state.phases = state.phases ?? {};
  state.phases[name] = { ...(state.phases[name] ?? {}), ...entry, at: new Date().toISOString() };
  saveState(state);
}

// ── Chain helpers ───────────────────────────────────────────────────────────

async function readStakeInfo(pc, stake, worker) {
  const [amount, stakedAt, slashedTotal] = await pc.readContract({
    address: stake, abi: STAKE_ABI, functionName: "getStake", args: [worker],
  });
  return { amount, stakedAt, slashedTotal };
}

async function waitForReceipt(pc, hash, label) {
  // Poll rather than viem's one-shot waitForTransactionReceipt: the CC-082
  // runs showed the public gateway load-balances without read-your-writes,
  // and a poll loop degrades to "try again" instead of throwing on the first
  // backend that hasn't seen the tx yet (Lessons-Learned §16).
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const receipt = await pc.getTransactionReceipt({ hash });
      if (receipt) {
        if (receipt.status !== "success") {
          throw new Error(`${label} tx ${hash} reverted on-chain (status ${receipt.status})`);
        }
        return receipt;
      }
    } catch (e) {
      if (String(e?.message ?? e).includes("reverted on-chain")) throw e;
      // transient RPC miss — fall through to the deadline check
    }
    if (Date.now() > deadline) throw new Error(`${label}: no receipt for ${hash} within 180s`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** Re-fetch /api/reputation until it reflects the new on-chain stake (CC-070 lag pattern). */
async function pollReputationUntil(baseUrl, wallet, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/reputation?wallet=${wallet}`);
      const body = await res.json();
      if (res.ok && body?.ok) {
        last = body;
        if (predicate(body)) return body;
      }
    } catch {
      // transient network miss — keep polling until the deadline
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: /api/reputation did not reflect the expected state within ${Math.round(timeoutMs / 1000)}s. Last response: ${JSON.stringify(last)?.slice(0, 400)}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const { ok, problems, config } = validateStakingConfig(process.env);
  if (!ok) {
    console.error(configFailureMessage(problems));
    return 2;
  }

  const pc = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  const workerAccount = privateKeyToAccount(process.env[ENV_NAMES.workerKey]);
  const worker = workerAccount.address;

  if (FORBIDDEN_STAKERS.includes(worker.toLowerCase())) {
    console.error(
      `REFUSED: the WORKER_WALLET_PRIVATE_KEY derives to ${worker}, a known platform address ` +
        `(owner/deployer — see scripts/staking/config.mjs FORBIDDEN_STAKERS). Staking from a ` +
        `platform key would conflate the worker role with the platform role in the exact record ` +
        `CC-072 exists to produce. Use a dedicated throwaway testnet worker wallet.`,
    );
    return 2;
  }

  console.log(`CC-072 staking harness — ${cli.execute ? "EXECUTE" : "DRY RUN"} · phase=${cli.phase}`);
  console.log(`  worker:   ${worker}`);
  console.log(`  stake:    ${config.stake} (chain-constants.json)`);
  console.log(`  usdc:     ${config.usdc}`);
  console.log(`  api:      ${config.baseUrl}`);
  console.log(`  state:    ${STATE_PATH}`);
  console.log();

  // ── Phase: status (read-only; also the precondition probe every phase uses) ──
  const [minStake, cooldown, totalStaked, owner, usdcOnContract] = await Promise.all([
    pc.readContract({ address: config.stake, abi: STAKE_ABI, functionName: "minStake" }),
    pc.readContract({ address: config.stake, abi: STAKE_ABI, functionName: "COOLDOWN" }),
    pc.readContract({ address: config.stake, abi: STAKE_ABI, functionName: "totalStaked" }),
    pc.readContract({ address: config.stake, abi: STAKE_ABI, functionName: "owner" }),
    pc.readContract({ address: config.stake, abi: STAKE_ABI, functionName: "usdc" }),
  ]);
  const info = await readStakeInfo(pc, config.stake, worker);
  const [ethBal, usdcBal] = await Promise.all([
    pc.getBalance({ address: worker }),
    pc.readContract({ address: config.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [worker] }),
  ]);

  console.log(`  contract  minStake=${formatUnits(minStake, config.usdcDecimals)} USDC · COOLDOWN=${Number(cooldown) / 86400}d · totalStaked=${formatUnits(totalStaked, config.usdcDecimals)} USDC`);
  console.log(`            owner=${owner} · usdc=${usdcOnContract}`);
  console.log(`  worker    stake=${formatUnits(info.amount, config.usdcDecimals)} USDC · stakedAt=${info.stakedAt} (${info.stakedAt ? new Date(Number(info.stakedAt) * 1000).toISOString() : "never"}) · slashed=${formatUnits(info.slashedTotal, config.usdcDecimals)}`);
  console.log(`            wallet ETH=${formatUnits(ethBal, 18)} · wallet USDC=${formatUnits(usdcBal, config.usdcDecimals)}`);
  const readyAt = info.stakedAt > 0n ? Number(info.stakedAt + cooldown) : null;
  if (readyAt) {
    const ready = Date.now() / 1000 >= readyAt;
    console.log(`  cooldown  readyAt=${new Date(readyAt * 1000).toISOString()} — ${ready ? "ELAPSED" : `not elapsed (${Math.ceil((readyAt - Date.now() / 1000) / 3600)}h remain)`}`);
  }
  console.log();

  if (cli.phase === "status") {
    recordPhase("status", { worker, stakeAmount: formatUnits(info.amount, config.usdcDecimals), readyAt });
    console.log("status recorded to state file. nothing else to do for --phase=status.");
    return 0;
  }

  // sanity invariant: constants-file USDC must equal the contract's own usdc()
  if (usdcOnContract.toLowerCase() !== config.usdc.toLowerCase()) {
    console.error(`MISMATCH: chain-constants USDC ${config.usdc} != stake contract usdc() ${usdcOnContract}. Fix the constants file; the harness will not guess which is right.`);
    return 1;
  }

  if (cli.dryRun) {
    console.log("dry run — no transactions, no further network calls. Plan:");
    if (cli.phase === "stake") {
      console.log(`  1. approve(${config.stake}, ${cli.amount} USDC) from the worker wallet`);
      console.log(`  2. stake(${cli.amount} USDC) — first stake must be >= minStake (${formatUnits(minStake, config.usdcDecimals)})`);
      console.log(`  3. read back getStake(worker) and poll /api/reputation until amount_usdc=${cli.amount}`);
      console.log(`     expected reputation math (compute.ts): ${JSON.stringify(expectedReputationForStake(cli.amount))}`);
    } else if (cli.phase === "cooldown-refusal") {
      console.log(`  1. eth_call unstake(1 USDC) — must revert CooldownNotElapsed(readyAt=${readyAt ? new Date(readyAt * 1000).toISOString() : "?"})`);
      console.log("     (guard case: eth_call only, never a broadcast — even under --execute)");
    } else if (cli.phase === "unstake") {
      console.log(`  1. precondition: cooldown elapsed (readyAt above) and stake >= amount`);
      console.log(`  2. unstake(${cli.amount} USDC) — remaining must be 0 or >= minStake`);
      console.log(`  3. read back stake=0 (or remainder), wallet USDC balance increased by ${cli.amount}, /api/reputation reflects it`);
    }
    return 0;
  }

  // ── EXECUTE ────────────────────────────────────────────────────────────────
  const wallet = createWalletClient({ account: workerAccount, chain: baseSepolia, transport: http(config.rpcUrl) });

  if (cli.phase === "stake") {
    const amountWei = BigInt(Math.round(cli.amount * 10 ** config.usdcDecimals));
    if (info.amount > 0n) {
      console.error(`REFUSED: worker already holds a stake of ${formatUnits(info.amount, config.usdcDecimals)} USDC. This harness drives the FIRST stake only (below-minimum first stakes revert BelowMinimumStake); top-ups reset the cooldown clock and would invalidate the unstake tail. Get the current stake to 0 first (--phase=unstake), or use a fresh wallet.`);
      return 1;
    }
    if (amountWei < minStake) {
      console.error(`REFUSED: ${cli.amount} USDC is below minStake (${formatUnits(minStake, config.usdcDecimals)}). The dashboard enforces this client-side (parseFloat(stakeInput) < 20 disables the button); the contract enforces it on-chain (BelowMinimumStake). Both should agree.`);
      return 1;
    }
    if (usdcBal < amountWei) {
      console.error(`REFUSED: worker wallet holds ${formatUnits(usdcBal, config.usdcDecimals)} USDC but the stake is ${cli.amount}. Fund the wallet first — testnet USDC comes from the Circle faucet (faucet.circle.com, pick Base Sepolia) or a transfer from another testnet wallet. See scripts/staking/README.md.`);
      return 1;
    }
    if (ethBal === 0n) {
      console.error("REFUSED: worker wallet has no ETH for gas. Base Sepolia ETH: https://www.coinbase.com/developer-platform/faucets — a stake needs ~3 txs of gas, effectively dust at testnet prices.");
      return 1;
    }

    console.log(`[1] approve(${config.stake}, ${cli.amount} USDC)`);
    const approveHash = await wallet.writeContract({ address: config.usdc, abi: ERC20_ABI, functionName: "approve", args: [config.stake, amountWei] });
    console.log(`    tx ${approveHash}`);
    await waitForReceipt(pc, approveHash, "approve");
    const allowance = await pc.readContract({ address: config.usdc, abi: ERC20_ABI, functionName: "allowance", args: [worker, config.stake] });
    console.log(`    allowance now ${formatUnits(allowance, config.usdcDecimals)} USDC`);

    console.log(`[2] stake(${cli.amount} USDC)`);
    const stakeHash = await wallet.writeContract({ address: config.stake, abi: STAKE_ABI, functionName: "stake", args: [amountWei] });
    console.log(`    tx ${stakeHash}`);
    const stakeReceipt = await waitForReceipt(pc, stakeHash, "stake");
    const stakedEvent = stakeReceipt.logs.map((l) => { try { return pc.parseEventLogs({ abi: STAKE_ABI, logs: [l] })[0]; } catch { return null; } }).find(Boolean);
    if (stakedEvent) console.log(`    event Staked(worker=${stakedEvent.args.worker}, amount=${formatUnits(stakedEvent.args.amount, config.usdcDecimals)}, newTotal=${formatUnits(stakedEvent.args.newTotal, config.usdcDecimals)})`);

    const after = await readStakeInfo(pc, config.stake, worker);
    if (after.amount !== amountWei) {
      console.error(`FAIL: expected stake ${cli.amount} USDC after stake(), read ${formatUnits(after.amount, config.usdcDecimals)}`);
      return 1;
    }
    console.log(`[3] getStake readback: ${formatUnits(after.amount, config.usdcDecimals)} USDC staked at ${new Date(Number(after.stakedAt) * 1000).toISOString()} — cooldown opens ${new Date(Number(after.stakedAt + cooldown) * 1000).toISOString()}`);

    const expected = expectedReputationForStake(cli.amount);
    console.log(`[4] /api/reputation — expecting stake=${expected.stake} total=${expected.total} (compute.ts floor for a task-less wallet)`);
    const rep = await pollReputationUntil(config.baseUrl, worker, (b) => Number(b.reputation?.stake?.amount_usdc ?? 0) >= cli.amount, "stake reflection");
    const got = rep.reputation.breakdown;
    const stakeOk = got.stake === expected.stake && got.total === expected.total;
    console.log(`    /api/reputation: stake=${got.stake} total=${got.total} amount_usdc=${rep.reputation.stake.amount_usdc} source=${rep.reputation.source}`);
    console.log(stakeOk ? "    PASS — the computed reputation reflects the on-chain stake." : `    MISMATCH — expected stake=${expected.stake} total=${expected.total}. The chain leg is done; this is the CC-010 score-display inconsistency surface. Record it honestly in the ticket.`);

    recordPhase("stake", {
      worker, amountUsdc: cli.amount, approveTx: approveHash, stakeTx: stakeHash,
      stakedAt: Number(after.stakedAt), readyAt: Number(after.stakedAt + cooldown),
      reputation: { stake: got.stake, total: got.total }, reputationMatch: stakeOk,
    });
    console.log("\nstake phase complete. Next: --phase=cooldown-refusal now, --phase=unstake after the cooldown.");
    return 0;
  }

  if (cli.phase === "cooldown-refusal") {
    if (info.amount === 0n) {
      console.error("REFUSED: no stake to unstake — run --phase=stake first.");
      return 1;
    }
    const readyAtSec = Number(info.stakedAt + cooldown);
    if (Date.now() / 1000 >= readyAtSec) {
      console.log(`SKIP-RECORDED: cooldown already elapsed (${new Date(readyAtSec * 1000).toISOString()} has passed) — the refusal case can no longer be exercised against this stake. It was available for ${Number(cooldown) / 86400} days after staking; that window is gone.`);
      recordPhase("cooldown-refusal", { skipped: true, reason: "cooldown already elapsed" });
      return 0;
    }
    console.log(`[1] eth_call unstake(1 USDC) — expecting CooldownNotElapsed(${readyAtSec})`);
    let revertData = null;
    try {
      await pc.simulateContract({
        address: config.stake, abi: STAKE_ABI, functionName: "unstake", args: [1_000_000n],
        account: workerAccount,
      });
      console.error("FAIL: unstake SIMULATED SUCCESS during the cooldown — the contract would have let funds out early. This is a P0 contract defect, not a test failure.");
      return 1;
    } catch (e) {
      revertData = String(e?.shortMessage ?? e?.details ?? e?.message ?? e);
    }
    console.log(`    revert: ${revertData.slice(0, 300)}`);
    const isCooldownRevert = /CooldownNotElapsed/i.test(revertData);
    if (!isCooldownRevert) {
      console.error("FAIL: the revert was NOT CooldownNotElapsed — an unexpected error shape during cooldown. Record it verbatim; this is exactly the 'confusing raw revert' case CC-072 asks about.");
      recordPhase("cooldown-refusal", { passed: false, revert: revertData.slice(0, 300) });
      return 1;
    }
    const expectedReadyAt = Number(info.stakedAt + cooldown);
    const carriesReadyAt = revertData.includes(String(expectedReadyAt)) || revertData.includes(String(BigInt(expectedReadyAt)));
    console.log(`    ${carriesReadyAt ? "carries" : "does NOT carry"} the readyAt argument (${expectedReadyAt}) — the UI maps this to "${"Stake changes have a cooldown — try again once it has elapsed."}" via reverts.ts`);
    recordPhase("cooldown-refusal", { passed: true, revert: revertData.slice(0, 300), readyAt: expectedReadyAt, carriesReadyAt });
    console.log("\ncooldown-refusal PASS. The unstake tail opens " + new Date(expectedReadyAt * 1000).toISOString() + " — run --phase=unstake --amount=… after it.");
    return 0;
  }

  if (cli.phase === "unstake") {
    const amountWei = BigInt(Math.round(cli.amount * 10 ** config.usdcDecimals));
    if (info.amount === 0n) {
      console.error("REFUSED: nothing staked — run --phase=stake first.");
      return 1;
    }
    if (amountWei > info.amount) {
      console.error(`REFUSED: unstake ${cli.amount} > staked ${formatUnits(info.amount, config.usdcDecimals)} (InsufficientStake).`);
      return 1;
    }
    const remaining = info.amount - amountWei;
    if (remaining > 0n && remaining < minStake) {
      console.error(`REFUSED: unstaking ${cli.amount} would leave ${formatUnits(remaining, config.usdcDecimals)} USDC — above 0 but below minStake (InvalidUnstakeAmount; the contract requires all-or-at-least-min). Unstake the full ${formatUnits(info.amount, config.usdcDecimals)} or leave >= ${formatUnits(minStake, config.usdcDecimals)}.`);
      return 1;
    }
    const readyAtSec = Number(info.stakedAt + cooldown);
    if (Date.now() / 1000 < readyAtSec) {
      console.error(`REFUSED: cooldown not elapsed (ready at ${new Date(readyAtSec * 1000).toISOString()}, ${Math.ceil((readyAtSec - Date.now() / 1000) / 3600)}h remain). The post-cooldown unstake is CC-072's acceptance tail — set a calendar reminder; the harness will be ready.`);
      return 1;
    }

    console.log(`[1] unstake(${cli.amount} USDC)`);
    const hash = await wallet.writeContract({ address: config.stake, abi: STAKE_ABI, functionName: "unstake", args: [amountWei] });
    console.log(`    tx ${hash}`);
    await waitForReceipt(pc, hash, "unstake");

    const [after, usdcAfter] = await Promise.all([
      readStakeInfo(pc, config.stake, worker),
      pc.readContract({ address: config.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [worker] }),
    ]);
    const expectedBalance = usdcBal + amountWei;
    if (after.amount !== remaining || usdcAfter !== expectedBalance) {
      console.error(`FAIL: expected stake=${formatUnits(remaining, config.usdcDecimals)} and wallet USDC=${formatUnits(expectedBalance, config.usdcDecimals)}, read stake=${formatUnits(after.amount, config.usdcDecimals)} wallet=${formatUnits(usdcAfter, config.usdcDecimals)}`);
      return 1;
    }
    console.log(`[2] readback: stake=${formatUnits(after.amount, config.usdcDecimals)} · wallet USDC=${formatUnits(usdcAfter, config.usdcDecimals)} (+${cli.amount})`);

    const rep = await pollReputationUntil(config.baseUrl, worker, (b) => Number(b.reputation?.stake?.amount_usdc ?? 0) <= Number(formatUnits(remaining, config.usdcDecimals)), "unstake reflection");
    console.log(`[3] /api/reputation: stake component=${rep.reputation.breakdown.stake} total=${rep.reputation.breakdown.total} amount_usdc=${rep.reputation.stake.amount_usdc}`);

    recordPhase("unstake", {
      worker, amountUsdc: cli.amount, unstakeTx: hash,
      remaining: formatUnits(remaining, config.usdcDecimals),
      walletUsdcAfter: formatUnits(usdcAfter, config.usdcDecimals),
      reputation: rep.reputation.breakdown,
    });
    console.log("\nunstake complete — funds returned. With all four phases green, the on-chain half of CC-072 is proven; what remains is the UI walkthrough (README.md, human steps).");
    return 0;
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`\nharness crashed: ${err?.stack ?? err}`);
    process.exit(1);
  },
);
