/**
 * verify-getlogs-recovery.mjs — READ-ONLY. CC-070 acceptance evidence.
 *
 * CC-070's acceptance asks for proof that the dispute-recovery query "actually recovers
 * a real past TaskResolved event rather than silently returning null because the query
 * range was too narrow, or throwing because it was too wide."
 *
 * There is exactly one real TaskResolved event in existence: the 1 USDC dispute
 * resolution CC-059 performed on 2026-07-30, tx 0x08cd2e37…. This script:
 *
 *   1. reads that transaction's receipt and decodes the TaskResolved log, giving the
 *      true taskId / releasedToWorker / amount independently of any query logic;
 *   2. demonstrates the OLD behaviour — one unbounded getLogs from block 0 — still
 *      fails against the live endpoint;
 *   3. runs the NEW behaviour — newest-first windows of RPC_MAX_BLOCK_RANGE blocks,
 *      bounded below by that escrow's deploy block, stopping at the first hit — and
 *      checks the recovered values match the receipt exactly, reporting the request
 *      count.
 *
 * Scope note, stated plainly: this reproduces the *query shape* used by
 * getTaskResolvedOutcome rather than importing it, because that function lives behind
 * TypeScript path aliases and takes a payment_request_id whose preimage is not
 * recoverable from the chain (taskId is keccak256 of it). The function's own logic —
 * window arithmetic, newest-first ordering, early exit, empty-range handling — is
 * covered by src/lib/__tests__/escrow-chunked.test.ts. This script is the live-chain
 * half of the evidence: that the ranges chosen are ones the real endpoint accepts, and
 * that a real historical event is genuinely found.
 *
 * **This is historical evidence, not a live check — every input is pinned (CC-082).**
 * It read NEXT_PUBLIC_ESCROW_CONTRACT and ESCROW_DEPLOY_BLOCK from the environment
 * until the v2 redeploy moved both out from under it, at which point it failed at step
 * 1 with "no TaskResolved log found". Reading live config implied it tracked the
 * current deployment; it never did. The one and only TaskResolved event in existence
 * was emitted by the **v1** escrow, so the escrow address and its deploy block are now
 * constants alongside CC059_TX. That is also why CC-085 deliberately left this out of
 * the monitor registry: it asserts a fact about the past, which cannot regress.
 *
 * The query shape it validates is still shipping — getTaskResolvedOutcome
 * (src/lib/contracts/escrow.ts) is live on the resolve_dispute recovery path, and v2
 * still declares TaskResolved — so the evidence stands. Re-point these constants only
 * once a v2 (or mainnet) TaskResolved event actually exists to prove it against.
 *
 * Executes no writes and sends no transactions.
 *
 *   node --env-file=.env.local scripts/audit/verify-getlogs-recovery.mjs
 *
 * Exit codes: 0 recovered and matched · 1 mismatch or not found · 2 misconfigured
 */

import { createPublicClient, http, parseAbiItem, decodeEventLog } from "viem";
import { baseSepolia } from "viem/chains";

const CC059_TX =
  "0x08cd2e374b5f7399370ffd767bcdf2b1fe063078fd8269e13b172d2984b918eb";

/**
 * The v1 CarbonEscrow on Base Sepolia — the contract that emitted CC059_TX's
 * TaskResolved. Superseded as the live deployment by v2
 * (0xe80d03688E8fa6270668AD73191d353e522CB1b1, CC-082), which is why this is pinned
 * rather than read from NEXT_PUBLIC_ESCROW_CONTRACT. Verify with:
 *   the `to` and the log address on
 *   https://sepolia.basescan.org/tx/0x08cd2e374b5f7399370ffd767bcdf2b1fe063078fd8269e13b172d2984b918eb
 */
const V1_ESCROW = "0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7";

/**
 * v1's deployment block, found by scripts/audit/find-deploy-block.mjs (CC-070).
 * Pinned for the same reason as V1_ESCROW: ESCROW_DEPLOY_BLOCK now carries v2's
 * 45494043, which is *above* the CC-059 event at 45204414 — so an env-driven lower
 * bound would scan a range that starts after the event and correctly find nothing.
 */
const V1_DEPLOY_BLOCK = 39032720n;

const TASK_RESOLVED = parseAbiItem(
  "event TaskResolved(bytes32 indexed taskId, bool releasedToWorker, uint256 amount)",
);

async function main() {
  // Sepolia regardless of NEXT_PUBLIC_BASE_NETWORK — the pinned event is a Sepolia
  // fact, so a mainnet cutover must not silently retarget this at a chain that has
  // never held it.
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;

  // `?? "10000"` was wrong: ?? only catches null/undefined, so an env var present but
  // empty gave BigInt("") === 0n, and the window loop below never advanced. Treat
  // empty/whitespace as unset, and reject a zero or negative cap outright.
  const rangeRaw = process.env.RPC_MAX_BLOCK_RANGE?.trim();
  let maxRange;
  try {
    maxRange = rangeRaw ? BigInt(rangeRaw) : 10000n;
  } catch {
    console.error(`MISCONFIGURED: RPC_MAX_BLOCK_RANGE is not an integer: "${rangeRaw}"`);
    return 2;
  }
  if (maxRange <= 0n) {
    console.error(`MISCONFIGURED: RPC_MAX_BLOCK_RANGE must be positive, got ${maxRange}.`);
    return 2;
  }

  const escrow = V1_ESCROW;
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl || undefined) });

  console.log(`escrow            ${escrow}  (v1, pinned — see the header)`);
  console.log(`rpc               ${rpcUrl ? "dedicated endpoint" : "public sepolia.base.org"}`);
  console.log(`deploy block      ${V1_DEPLOY_BLOCK}  (v1, pinned)`);
  console.log(`RPC_MAX_BLOCK_RANGE  ${maxRange}${rangeRaw ? "" : "  (default)"}`);

  // Say out loud that the live deployment has moved on, so a reader running this does
  // not mistake a pinned historical pass for a statement about the current contract.
  const live = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  if (live && live.toLowerCase() !== escrow.toLowerCase()) {
    console.log("");
    console.log(`note: the live escrow is ${live}.`);
    console.log("      This script deliberately ignores it — see the header. It proves the");
    console.log("      recovery query against the only TaskResolved event that exists, which");
    console.log("      v1 emitted. It is not a check on the current deployment.");
  }
  console.log("");

  // ── 1. ground truth from the receipt ──────────────────────────────────────
  console.log("1. Ground truth from the CC-059 transaction receipt");
  let truth;
  try {
    const receipt = await client.getTransactionReceipt({ hash: CC059_TX });
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== escrow.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [TASK_RESOLVED], data: lg.data, topics: lg.topics });
        if (decoded.eventName === "TaskResolved") {
          truth = { ...decoded.args, blockNumber: receipt.blockNumber };
          break;
        }
      } catch {
        // not this event
      }
    }
  } catch (err) {
    console.error(`   could not fetch the receipt: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (!truth) {
    console.error(`   no TaskResolved log found in that transaction, emitted by ${escrow}.`);
    console.error("   Both are pinned constants in this file, so this should not happen —");
    console.error("   check them against the transaction on sepolia.basescan.org.");
    return 1;
  }

  console.log(`   block            ${truth.blockNumber}`);
  console.log(`   taskId           ${truth.taskId}`);
  console.log(`   releasedToWorker ${truth.releasedToWorker}`);
  console.log(`   amount           ${truth.amount} units`);
  console.log("");

  // ── 2. the old behaviour ──────────────────────────────────────────────────
  console.log("2. OLD behaviour — a single unbounded getLogs from block 0");
  try {
    await client.getLogs({
      address: escrow,
      event: TASK_RESOLVED,
      args: { taskId: truth.taskId },
      fromBlock: 0n,
      toBlock: "latest",
    });
    console.log("   UNEXPECTED: the unbounded query succeeded. The provider limit may have");
    console.log("   been lifted. The chunking is still correct, but re-check RPC_MAX_BLOCK_RANGE.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = msg.split("\n").find((l) => /range|limit|exceed/i.test(l)) ?? msg.split("\n")[0];
    console.log(`   fails as expected: ${detail.trim()}`);
  }
  console.log("");

  // ── 3. the new behaviour ──────────────────────────────────────────────────
  console.log("3. NEW behaviour — newest-first windows, bounded below, early exit");
  const head = await client.getBlockNumber();
  const from = V1_DEPLOY_BLOCK;

  const windows = [];
  for (let start = from; start <= head; start += maxRange) {
    const end = start + maxRange - 1n;
    windows.push([start, end > head ? head : end]);
  }
  windows.reverse();

  let requests = 0;
  let found = null;
  for (const [fromBlock, toBlock] of windows) {
    requests++;
    const logs = await client.getLogs({
      address: escrow,
      event: TASK_RESOLVED,
      args: { taskId: truth.taskId },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) {
      found = logs[logs.length - 1];
      break;
    }
  }

  console.log(`   windows available ${windows.length}`);
  console.log(`   requests made     ${requests}`);
  // Both numbers grow with chain length — the scan is newest-first and the event is
  // fixed in the past, so it drifts further from head every day. CC-070 recorded
  // 18 of 635 on 2026-08-11; a larger figure here is age, not a regression. What the
  // evidence turns on is that the scan terminates on a real hit, not on its cost.
  console.log("   (both grow with chain age — 18 of 635 when measured on 2026-08-11)");

  if (!found) {
    console.error("   FAIL — scanned the whole bounded range and found nothing.");
    return 1;
  }

  console.log(`   recovered at block ${found.blockNumber}`);
  console.log("");

  const ok =
    found.args.taskId === truth.taskId &&
    found.args.releasedToWorker === truth.releasedToWorker &&
    found.args.amount === truth.amount &&
    found.blockNumber === truth.blockNumber;

  if (!ok) {
    console.error("FAIL — recovered values do not match the receipt.");
    console.error(`  receipt   ${truth.releasedToWorker} / ${truth.amount} / block ${truth.blockNumber}`);
    console.error(
      `  recovered ${found.args.releasedToWorker} / ${found.args.amount} / block ${found.blockNumber}`,
    );
    return 1;
  }

  console.log("PASS — a real historical TaskResolved event was recovered, and every field");
  console.log("matches the transaction receipt: taskId, releasedToWorker, amount, block.");
  console.log("");
  console.log("This is the CC-070 acceptance criterion: the recovery path neither throws on");
  console.log("an over-wide range nor silently returns null on an over-narrow one.");
  return 0;
}

process.exitCode = await main();
