/**
 * verify-concurrent-escrow.mjs — READ-ONLY. CC-085, ADR-0003 D2, CC-051 item 2.
 *
 * Measures the two numbers the AU Digital Assets Framework's small-scale exemption turns
 * on, and fails when either approaches its limb:
 *
 *   · peak concurrent USDC escrowed per funding agent   (the $5,000-per-client limb)
 *   · USDC funded over the trailing 365 days            (the $10m annual-volume limb)
 *
 * ## Why concurrency, not job size (CC-051)
 *
 * The exemption needs BOTH limbs. Intuition says a microtask marketplace cannot get near
 * $5,000 per client, and for a single job that is right. But the per-client limb is about
 * aggregate held at a point in time, and the agentic use case is precisely one agent
 * batching many small tasks: thirty concurrent $200 tasks is $6,000 held for that client
 * without a single job exceeding $200. So the limb binds on concurrency, and totals alone
 * cannot see it. Cheap to instrument now, awkward to reconstruct later — which is the
 * whole reason this is a monitor and not a report.
 *
 * This is measurement, not legal advice, and it is not a claim that the platform is a
 * Digital Asset Platform. CC-051 wants a lawyer's view; this exists so the lawyer is
 * reasoning about measured numbers. Framework commences 2027-04-09.
 *
 * ## Method
 *
 * Replays the escrow's own event log. TaskCreated adds to a funding agent's balance;
 * TaskCompleted / TaskResolved / TaskExpired remove it. TaskDisputed and ArbitrationBegun
 * are deliberately NOT terminal — funds stay locked through a dispute, so treating them as
 * exits would understate the peak, which is the number that matters.
 *
 * Terminal events do not carry the agent address, so the agent comes from that task's
 * TaskCreated event. Deltas are applied in (blockNumber, logIndex) order, which is the
 * only ordering that gives a true peak: two events in one block are not simultaneous.
 *
 * ## The self-check that makes the output trustworthy
 *
 * After the replay, the sum of every agent's open balance must equal the contract's own
 * totalLocked(). If it does not, the replay is wrong — a missed event, a mis-classified
 * terminal state, a truncated block range — and every number above it is wrong too. That
 * is a failure, and a louder one than a threshold breach: a threshold breach is a fact
 * about the business, a replay mismatch means the instrument is lying.
 *
 * Executes no writes and sends no transactions.
 *
 *   node --env-file=.env.local scripts/audit/verify-concurrent-escrow.mjs
 *   node --env-file=.env.local scripts/audit/verify-concurrent-escrow.mjs --per-client-limit=5000
 *
 * Env overrides: MONITOR_PER_CLIENT_LIMIT_USDC (5000), MONITOR_ANNUAL_VOLUME_LIMIT_USDC
 * (10000000), MONITOR_THRESHOLD_WARN_RATIO (0.8).
 *
 * Exit codes: 0 clean (warnings still exit 0) · 1 limb breached or replay mismatch ·
 *             2 misconfigured or RPC failure
 */

import { createPublicClient, http, getAddress, formatUnits, parseAbiItem } from "viem";
import { base, baseSepolia } from "viem/chains";

const EVENTS = {
  created: parseAbiItem(
    "event TaskCreated(bytes32 indexed taskId, address indexed agent, address indexed worker, uint256 amount, uint64 deadline, uint32 reviewWindow, bytes32 specHash)",
  ),
  completed: parseAbiItem(
    "event TaskCompleted(bytes32 indexed taskId, address indexed worker, uint256 amount, uint8 route)",
  ),
  resolved: parseAbiItem(
    "event TaskResolved(bytes32 indexed taskId, bool releasedToWorker, uint256 amount)",
  ),
  expired: parseAbiItem("event TaskExpired(bytes32 indexed taskId, uint256 refunded)"),
};

const ESCROW_ABI = [
  { type: "function", name: "totalLocked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const USDC_UNIT = 1_000_000n; // 6 decimals on Base
const YEAR_SECONDS = 365 * 86_400;

const usdcFmt = (v) => `${formatUnits(v, 6)} USDC`;

/** See getLogsChunked in src/lib/contracts/escrow.ts — CC-070. */
async function getLogsChunked(client, { address, event, fromBlock, toBlock, span }) {
  if (toBlock < fromBlock) return [];
  const collected = [];
  for (let start = fromBlock; start <= toBlock; start += span) {
    const end = start + span - 1n;
    collected.push(
      ...(await client.getLogs({
        address,
        event,
        fromBlock: start,
        toBlock: end > toBlock ? toBlock : end,
      })),
    );
  }
  return collected;
}

function numArg(args, flag, envName, fallback) {
  const raw =
    args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3) ??
    process.env[envName] ??
    fallback;
  return Number(raw);
}

async function main() {
  const args = process.argv.slice(2);
  const escrowRaw = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK ?? "testnet";
  const mainnet = network === "mainnet";
  const rpcUrl = mainnet ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;

  if (!escrowRaw) {
    console.error("MISCONFIGURED: NEXT_PUBLIC_ESCROW_CONTRACT is required.");
    return 2;
  }
  // Empty, not just undefined — an unset Actions variable arrives as "" and BigInt("")
  // is 0n, which would scan from genesis instead of erroring.
  if (!process.env.ESCROW_DEPLOY_BLOCK) {
    console.error("MISCONFIGURED: ESCROW_DEPLOY_BLOCK is required — see CC-070.");
    console.error("A peak computed from a truncated range is not a peak, it is a guess.");
    return 2;
  }

  const perClientLimit = numArg(args, "per-client-limit", "MONITOR_PER_CLIENT_LIMIT_USDC", 5_000);
  const annualLimit = numArg(args, "annual-limit", "MONITOR_ANNUAL_VOLUME_LIMIT_USDC", 10_000_000);
  const warnRatio = numArg(args, "warn-ratio", "MONITOR_THRESHOLD_WARN_RATIO", 0.8);
  if (![perClientLimit, annualLimit].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(warnRatio) || warnRatio <= 0 || warnRatio > 1) {
    console.error("MISCONFIGURED: limits must be positive numbers and warn-ratio must be in (0,1].");
    return 2;
  }

  const escrow = getAddress(escrowRaw);
  const chain = mainnet ? base : baseSepolia;
  const deployBlock = BigInt(process.env.ESCROW_DEPLOY_BLOCK);
  // `||` again — BigInt("") is 0n, and a zero span makes the chunk loop never advance.
  const span = BigInt(process.env.RPC_MAX_BLOCK_RANGE || 10_000);
  const client = createPublicClient({ chain, transport: http(rpcUrl || undefined), batch: { multicall: true } });

  console.log("── Concurrent escrow per funding agent ──────────────────────────");
  console.log(`network   ${network} (chain ${chain.id})`);
  console.log(`escrow    ${escrow}`);
  console.log(`rpc       ${rpcUrl ? "dedicated endpoint" : "PUBLIC FALLBACK — rate limited, see CC-048"}`);
  console.log(`limbs     $${perClientLimit.toLocaleString()} per client concurrent · $${annualLimit.toLocaleString()} annual volume`);
  console.log(`warn at   ${(warnRatio * 100).toFixed(0)}% of either`);
  console.log("");

  let head, logs, totalLocked;
  try {
    head = await client.getBlockNumber();
    const range = { address: escrow, fromBlock: deployBlock, toBlock: head, span };
    const [created, completed, resolved, expired] = await Promise.all([
      getLogsChunked(client, { ...range, event: EVENTS.created }),
      getLogsChunked(client, { ...range, event: EVENTS.completed }),
      getLogsChunked(client, { ...range, event: EVENTS.resolved }),
      getLogsChunked(client, { ...range, event: EVENTS.expired }),
    ]);
    logs = { created, completed, resolved, expired };
    totalLocked = await client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "totalLocked" });
  } catch (err) {
    console.error(`RPC read failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  console.log(`blocks    ${deployBlock}..${head}  (${Number((head - deployBlock) / span) + 1} window(s) per event)`);
  console.log(
    `events    ${logs.created.length} created · ${logs.completed.length} completed · ` +
      `${logs.resolved.length} resolved · ${logs.expired.length} expired`,
  );
  console.log("");

  if (logs.created.length === 0) {
    console.log("CLEAN — no task has ever been funded on this deployment.");
    console.log("Vacuous: nothing has been escrowed, so the peak is trivially zero. This run");
    console.log("proves the query shape works and proves nothing about the thresholds.");
    return 0;
  }

  // ── Build the delta timeline ──────────────────────────────────────────────
  const agentOf = new Map(); // taskId -> agent
  const amountOf = new Map(); // taskId -> amount
  const deltas = [];

  for (const l of logs.created) {
    agentOf.set(l.args.taskId, getAddress(l.args.agent));
    amountOf.set(l.args.taskId, l.args.amount);
    deltas.push({ block: l.blockNumber, index: l.logIndex, taskId: l.args.taskId, delta: l.args.amount });
  }

  const orphans = [];
  for (const [kind, list] of [["completed", logs.completed], ["resolved", logs.resolved], ["expired", logs.expired]]) {
    for (const l of list) {
      const amount = amountOf.get(l.args.taskId);
      if (amount === undefined) {
        // A terminal event for a task whose TaskCreated is outside the scanned range.
        // Only possible with a wrong ESCROW_DEPLOY_BLOCK, and it would silently skew
        // every balance downward, so it is surfaced rather than dropped.
        orphans.push({ kind, taskId: l.args.taskId });
        continue;
      }
      deltas.push({ block: l.blockNumber, index: l.logIndex, taskId: l.args.taskId, delta: -amount });
    }
  }

  deltas.sort((a, b) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : Number(a.index) - Number(b.index)));

  // ── Replay ────────────────────────────────────────────────────────────────
  const balance = new Map(); // agent -> current
  const peak = new Map(); // agent -> { amount, block }
  const taskCount = new Map(); // agent -> tasks funded
  let globalBalance = 0n;
  let globalPeak = { amount: 0n, block: deployBlock };

  for (const d of deltas) {
    const agent = agentOf.get(d.taskId);
    if (!agent) continue; // already recorded as an orphan
    const next = (balance.get(agent) ?? 0n) + d.delta;
    balance.set(agent, next);
    globalBalance += d.delta;
    if (d.delta > 0n) taskCount.set(agent, (taskCount.get(agent) ?? 0) + 1);

    const p = peak.get(agent);
    if (!p || next > p.amount) peak.set(agent, { amount: next, block: d.block });
    if (globalBalance > globalPeak.amount) globalPeak = { amount: globalBalance, block: d.block };
  }

  // ── Trailing-365-day funded volume ────────────────────────────────────────
  const blockTimes = new Map();
  try {
    const uniqueBlocks = [...new Set(logs.created.map((l) => l.blockNumber))];
    const fetched = await Promise.all(uniqueBlocks.map((b) => client.getBlock({ blockNumber: b })));
    uniqueBlocks.forEach((b, i) => blockTimes.set(b, Number(fetched[i].timestamp)));
  } catch (err) {
    console.error(`block timestamp read failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const now = Math.floor(Date.now() / 1000);
  let annualVolume = 0n;
  let allTimeVolume = 0n;
  for (const l of logs.created) {
    allTimeVolume += l.args.amount;
    if (now - (blockTimes.get(l.blockNumber) ?? 0) <= YEAR_SECONDS) annualVolume += l.args.amount;
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const rows = [...peak.entries()].sort((a, b) => (b[1].amount > a[1].amount ? 1 : -1));
  const perClientLimitUnits = BigInt(Math.round(perClientLimit)) * USDC_UNIT;
  const perClientWarnUnits = BigInt(Math.round(perClientLimit * warnRatio)) * USDC_UNIT;
  const annualLimitUnits = BigInt(Math.round(annualLimit)) * USDC_UNIT;
  const annualWarnUnits = BigInt(Math.round(annualLimit * warnRatio)) * USDC_UNIT;

  console.log("funding agent                                 peak concurrent      now   tasks");
  for (const [agent, p] of rows) {
    const flag =
      p.amount >= perClientLimitUnits ? " BREACH" : p.amount >= perClientWarnUnits ? " warn" : "";
    console.log(
      `  ${agent}  ${usdcFmt(p.amount).padStart(16)}  ${usdcFmt(balance.get(agent) ?? 0n).padStart(12)}  ${String(taskCount.get(agent) ?? 0).padStart(5)}${flag}`,
    );
    console.log(`      peak reached at block ${p.block}`);
  }
  console.log("");
  console.log(`distinct funding agents        ${rows.length}`);
  console.log(`peak concurrent, all agents    ${usdcFmt(globalPeak.amount)} at block ${globalPeak.block}`);
  console.log(`funded, trailing 365 days      ${usdcFmt(annualVolume)}`);
  console.log(`funded, all time               ${usdcFmt(allTimeVolume)}`);
  console.log("");

  // ── Assertions ────────────────────────────────────────────────────────────
  const failures = [];
  const warnings = [];

  if (orphans.length > 0) {
    failures.push(
      `${orphans.length} terminal event(s) reference a task with no TaskCreated in the scanned ` +
        `range (first: ${orphans[0].kind} ${orphans[0].taskId}). ESCROW_DEPLOY_BLOCK is probably ` +
        "wrong — every balance below it is understated.",
    );
  }

  if (globalBalance !== totalLocked) {
    failures.push(
      `replay does not reconcile: the event timeline says ${usdcFmt(globalBalance)} is open, the ` +
        `contract says totalLocked() is ${usdcFmt(totalLocked)}. The instrument is wrong, so treat ` +
        "every number above as unreliable until this is explained.",
    );
  } else {
    console.log(`self-check  replay total ${usdcFmt(globalBalance)} == totalLocked() — reconciles.`);
    console.log("");
  }

  for (const [agent, p] of rows) {
    if (p.amount >= perClientLimitUnits) {
      failures.push(
        `${agent} peaked at ${usdcFmt(p.amount)} concurrent, at or over the $${perClientLimit.toLocaleString()} per-client limb.`,
      );
    } else if (p.amount >= perClientWarnUnits) {
      warnings.push(`${agent} peaked at ${usdcFmt(p.amount)} — past ${(warnRatio * 100).toFixed(0)}% of the per-client limb.`);
    }
  }

  if (annualVolume >= annualLimitUnits) {
    failures.push(`trailing-365-day funded volume ${usdcFmt(annualVolume)} is at or over the $${annualLimit.toLocaleString()} limb.`);
  } else if (annualVolume >= annualWarnUnits) {
    warnings.push(`trailing-365-day funded volume ${usdcFmt(annualVolume)} is past ${(warnRatio * 100).toFixed(0)}% of the annual limb.`);
  }

  for (const w of warnings) console.log(`WARN — ${w}`);
  if (warnings.length > 0) {
    console.log("");
    console.log("A warning is not a breach. It is the point at which CC-051's lawyer question");
    console.log("stops being theoretical — get the view before the limb is crossed, not after.");
    console.log("");
  }

  if (failures.length === 0) {
    console.log("CLEAN — both exemption limbs have headroom and the replay reconciles.");
    return 0;
  }

  console.log(`VIOLATION — ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  · ${f}`);
  console.log("");
  console.log("If a limb is genuinely breached this is not an outage and nothing should be");
  console.log("switched off in a hurry — the framework commences 2027-04-09 with a six-month");
  console.log("transition. It is the trigger to act on CC-051 item 1 (a considered legal view)");
  console.log("and to decide whether to cap per-agent concurrency in the app layer.");
  return 1;
}

process.exitCode = await main();
