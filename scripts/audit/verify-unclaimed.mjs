/**
 * verify-unclaimed.mjs — READ-ONLY. CC-085, ADR-0003 D2.
 *
 * Invariant: no `Delivered` task whose review window closed more than N days ago.
 *
 * Amendment 1 A1.2 made settlement pull-payment — the worker calls releaseAfterReview and
 * claims their own money. Nobody pushes it to them. So a worker who does not know to
 * claim, or whose claim reverts, sees a completed job and no payment. That is the contract
 * behaving exactly as designed, and it is indistinguishable from theft to the person it
 * happens to. It will be reported as a bug (ADR-0003, "unclaimed settlements look like
 * theft").
 *
 * A growing backlog of claimable-but-unclaimed tasks is therefore not an accounting
 * problem — it is the claim UX failing, measured from the outside. Nothing in the system
 * errors when it happens, which is why it needs a positive assertion on a schedule rather
 * than an error handler (ADR-0003 D3).
 *
 * ## What is checked
 *
 * Primary (decides the exit code): every WorkSubmitted event over the deployed block
 * range, each task's current state read from getTask(), and of those still `Delivered`,
 * how long ago `submittedAt + reviewWindow` passed.
 *
 * Secondary (informational only): tasks still `Funded` past their delivery deadline. The
 * agent's refund is a pull-payment too (A1.2 made expireTask agent-only), so the same UX
 * failure exists on the agent side. ADR-0003 and CC-085 only specify the worker case, so
 * this is reported and not asserted on — raise it to a failure once there is evidence of
 * what normal looks like.
 *
 * ## The threshold
 *
 * ADR-0003 leaves N open. Default 3 days, because MIN_REVIEW_WINDOW is 12h and a worker
 * who is owed money and knows it claims within hours; 3 days is long enough to absorb a
 * weekend without paging, and short enough to surface before a worker concludes they have
 * been robbed and says so publicly. Override with MONITOR_UNCLAIMED_MAX_AGE_DAYS or
 * --max-age-days=. Revisit once real claim latency exists to measure.
 *
 * Executes no writes and sends no transactions.
 *
 *   node --env-file=.env.local scripts/audit/verify-unclaimed.mjs
 *   node --env-file=.env.local scripts/audit/verify-unclaimed.mjs --max-age-days=1
 *   node --env-file=.env.local scripts/audit/verify-unclaimed.mjs --as-of=2026-09-01T00:00:00Z
 *
 * `--as-of` evaluates the invariant at a different wall-clock time against the real chain
 * state. It is how you answer "will this fire tomorrow" without waiting, and how the
 * detection path gets exercised while no violation exists yet.
 *
 * Exit codes: 0 clean · 1 violation · 2 misconfigured or RPC failure
 */

import { createPublicClient, http, getAddress, formatUnits, parseAbiItem } from "viem";
import { base, baseSepolia } from "viem/chains";

const WORK_SUBMITTED = parseAbiItem(
  "event WorkSubmitted(bytes32 indexed taskId, address indexed worker, bytes32 evidenceHash, uint64 submittedAt, bytes32 attestationUid)",
);
const TASK_CREATED = parseAbiItem(
  "event TaskCreated(bytes32 indexed taskId, address indexed agent, address indexed worker, uint256 amount, uint64 deadline, uint32 reviewWindow, bytes32 specHash)",
);

const GET_TASK_ABI = [
  {
    type: "function",
    name: "getTask",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "agent", type: "address" },
          { name: "deadline", type: "uint64" },
          { name: "reviewWindow", type: "uint32" },
          { name: "worker", type: "address" },
          { name: "submittedAt", type: "uint64" },
          { name: "state", type: "uint8" },
          { name: "verdictPassed", type: "bool" },
          { name: "amount", type: "uint256" },
          { name: "specHash", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "verdictHash", type: "bytes32" },
          { name: "attestationUid", type: "bytes32" },
        ],
      },
    ],
  },
];

/** v2 numbering (CC-082). Renumbered from v1 — Completed was 2, it is now 3. */
const STATE = { None: 0, Funded: 1, Delivered: 2, Completed: 3, Disputed: 4, Arbitrating: 5, Resolved: 6, Expired: 7 };

const usdcFmt = (v) => `${formatUnits(v, 6)} USDC`;
const short = (id) => `${id.slice(0, 10)}…${id.slice(-6)}`;
const days = (seconds) => (seconds / 86_400).toFixed(2);

/**
 * eth_getLogs split into windows the provider will accept, bounded below by the deploy
 * block. Mirrors getLogsChunked in src/lib/contracts/escrow.ts — an unbounded query scans
 * from genesis (~36x the requests, CC-070) and an over-wide window is rejected outright.
 */
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
  // Empty, not just undefined: an unset GitHub Actions secret or variable arrives as "",
  // and BigInt("") is 0n — which would scan from genesis rather than erroring.
  if (!process.env.ESCROW_DEPLOY_BLOCK) {
    console.error("MISCONFIGURED: ESCROW_DEPLOY_BLOCK is required.");
    console.error("Without it every event query scans from genesis — see CC-070 and");
    console.error("scripts/audit/find-deploy-block.mjs. Refusing to scan the whole chain.");
    return 2;
  }

  const maxAgeDays = Number(
    args.find((a) => a.startsWith("--max-age-days="))?.slice("--max-age-days=".length) ??
      process.env.MONITOR_UNCLAIMED_MAX_AGE_DAYS ??
      3,
  );
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error("MISCONFIGURED: --max-age-days / MONITOR_UNCLAIMED_MAX_AGE_DAYS must be > 0.");
    return 2;
  }

  const asOfRaw = args.find((a) => a.startsWith("--as-of="))?.slice("--as-of=".length);
  const asOf = asOfRaw
    ? Math.floor((/^\d+$/.test(asOfRaw) ? Number(asOfRaw) * 1000 : Date.parse(asOfRaw)) / 1000)
    : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(asOf)) {
    console.error(`MISCONFIGURED: could not parse --as-of=${asOfRaw}`);
    return 2;
  }

  const escrow = getAddress(escrowRaw);
  const chain = mainnet ? base : baseSepolia;
  const deployBlock = BigInt(process.env.ESCROW_DEPLOY_BLOCK);
  // `||` again — BigInt("") is 0n, and a zero span makes the chunk loop never advance.
  const span = BigInt(process.env.RPC_MAX_BLOCK_RANGE || 10_000);
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl || undefined),
    batch: { multicall: true },
  });

  console.log("── Unclaimed settlements ────────────────────────────────────────");
  console.log(`network   ${network} (chain ${chain.id})`);
  console.log(`escrow    ${escrow}`);
  console.log(`rpc       ${rpcUrl ? "dedicated endpoint" : "PUBLIC FALLBACK — rate limited, see CC-048"}`);
  console.log(`threshold ${maxAgeDays} day(s) past the review deadline`);
  console.log(`as of     ${new Date(asOf * 1000).toISOString()}${asOfRaw ? "  (--as-of override)" : ""}`);
  console.log("");

  let head, submitted, created;
  try {
    head = await client.getBlockNumber();
    const range = { address: escrow, fromBlock: deployBlock, toBlock: head, span };
    [submitted, created] = await Promise.all([
      getLogsChunked(client, { ...range, event: WORK_SUBMITTED }),
      getLogsChunked(client, { ...range, event: TASK_CREATED }),
    ]);
  } catch (err) {
    console.error(`RPC read failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const windows = Number((head - deployBlock) / span) + 1;
  console.log(`blocks    ${deployBlock}..${head}  (${windows} getLogs window(s) per event)`);
  console.log(`events    ${submitted.length} WorkSubmitted · ${created.length} TaskCreated`);
  console.log("");

  const submittedIds = [...new Set(submitted.map((l) => l.args.taskId))];
  const createdIds = [...new Set(created.map((l) => l.args.taskId))];
  const allIds = [...new Set([...submittedIds, ...createdIds])];

  if (allIds.length === 0) {
    console.log("CLEAN — no tasks exist on this deployment yet, so nothing can be unclaimed.");
    console.log("Note this is a vacuous pass. It stays vacuous until the lifecycle runs.");
    return 0;
  }

  let tasks;
  try {
    tasks = await Promise.all(
      allIds.map((taskId) =>
        client.readContract({ address: escrow, abi: GET_TASK_ABI, functionName: "getTask", args: [taskId] }),
      ),
    );
  } catch (err) {
    console.error(`getTask read failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const claimable = []; // Delivered, review window closed
  const inReview = []; // Delivered, window still open
  const staleFunded = []; // Funded, past the delivery deadline — agent's refund unclaimed

  for (let i = 0; i < allIds.length; i++) {
    const t = tasks[i];
    const state = Number(t.state);
    if (state === STATE.Delivered) {
      const reviewDeadline = Number(t.submittedAt) + Number(t.reviewWindow);
      const row = {
        taskId: allIds[i],
        worker: t.worker,
        amount: t.amount,
        reviewDeadline,
        age: asOf - reviewDeadline,
      };
      (asOf >= reviewDeadline ? claimable : inReview).push(row);
    } else if (state === STATE.Funded && asOf >= Number(t.deadline)) {
      staleFunded.push({
        taskId: allIds[i],
        agent: t.agent,
        amount: t.amount,
        age: asOf - Number(t.deadline),
      });
    }
  }

  claimable.sort((a, b) => b.age - a.age);
  const breaches = claimable.filter((c) => c.age > maxAgeDays * 86_400);
  const heldClaimable = claimable.reduce((s, c) => s + c.amount, 0n);

  console.log(`Delivered, window still open      ${inReview.length}`);
  console.log(`Delivered, claimable now          ${claimable.length}   ${usdcFmt(heldClaimable)}`);
  console.log(`  of those, older than ${String(maxAgeDays).padEnd(4)} day(s) ${breaches.length}`);
  console.log("");

  for (const c of claimable.slice(0, 20)) {
    const flag = c.age > maxAgeDays * 86_400 ? "BREACH" : "  ok  ";
    console.log(
      `  ${flag}  ${short(c.taskId)}  ${usdcFmt(c.amount).padStart(14)}  claimable for ${days(c.age).padStart(7)} d  worker ${c.worker}`,
    );
  }
  if (claimable.length > 20) console.log(`  … and ${claimable.length - 20} more`);
  if (claimable.length > 0) console.log("");

  // ── Informational: the agent side of the same pull-payment ────────────────
  if (staleFunded.length > 0) {
    const heldStale = staleFunded.reduce((s, c) => s + c.amount, 0n);
    console.log(`INFO — ${staleFunded.length} task(s) still Funded past the delivery deadline, ${usdcFmt(heldStale)}.`);
    console.log("These are the agent's to reclaim via expireTask, which Amendment 1 A1.2 also");
    console.log("made a pull-payment. Same UX failure, other party. Not asserted on: CC-085");
    console.log("specifies the worker case only, and there is no baseline yet for this one.");
    console.log("");
  }

  if (breaches.length === 0) {
    console.log("CLEAN — no Delivered task has been claimable for longer than the threshold.");
    if (claimable.length === 0 && inReview.length === 0) {
      console.log("");
      console.log("Caveat, stated plainly: no task is currently Delivered, so this run proves");
      console.log("the query works and proves nothing about the claim UX.");
    }
    return 0;
  }

  console.log(`VIOLATION — ${breaches.length} task(s) claimable for more than ${maxAgeDays} day(s).`);
  console.log("");
  console.log("The money is not lost and nobody has taken it: it sits in the escrow until the");
  console.log("worker calls releaseAfterReview. That is the problem. Check, in order:");
  console.log("  1. is the worker being told the task is claimable at all (notification path)?");
  console.log("  2. does the dashboard claim button exist, and does it reach the right chain?");
  console.log("  3. does the claim revert — wrong sender, review window arithmetic, gas?");
  console.log("  4. does the worker have any ETH on Base to pay for the claim?");
  console.log("Do NOT respond by claiming on their behalf. releaseAfterReview is worker-only by");
  console.log("design (A1.2), and the platform having a push path is the thing it does not want.");
  return 1;
}

process.exitCode = await main();
