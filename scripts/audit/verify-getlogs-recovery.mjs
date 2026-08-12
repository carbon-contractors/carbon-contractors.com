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
 *      bounded below by ESCROW_DEPLOY_BLOCK, stopping at the first hit — and checks the
 *      recovered values match the receipt exactly, reporting the request count.
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
 * Executes no writes and sends no transactions.
 *
 *   node --env-file=.env.local scripts/audit/verify-getlogs-recovery.mjs
 *
 * Exit codes: 0 recovered and matched · 1 mismatch or not found · 2 misconfigured
 */

import { createPublicClient, http, getAddress, parseAbiItem, decodeEventLog } from "viem";
import { baseSepolia } from "viem/chains";

const CC059_TX =
  "0x08cd2e374b5f7399370ffd767bcdf2b1fe063078fd8269e13b172d2984b918eb";

const TASK_RESOLVED = parseAbiItem(
  "event TaskResolved(bytes32 indexed taskId, bool releasedToWorker, uint256 amount)",
);

async function main() {
  const escrowRaw = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK ?? "testnet";
  const rpcUrl =
    network === "mainnet"
      ? process.env.BASE_MAINNET_RPC_URL
      : process.env.BASE_SEPOLIA_RPC_URL;
  const deployBlock = process.env.ESCROW_DEPLOY_BLOCK;
  const maxRange = BigInt(process.env.RPC_MAX_BLOCK_RANGE ?? "10000");

  if (!escrowRaw) {
    console.error("MISCONFIGURED: NEXT_PUBLIC_ESCROW_CONTRACT is required.");
    return 2;
  }
  if (network === "mainnet") {
    console.error("This script targets the Sepolia deployment that holds the CC-059 event.");
    return 2;
  }

  const escrow = getAddress(escrowRaw);
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl || undefined) });

  console.log(`escrow            ${escrow}`);
  console.log(`rpc               ${rpcUrl ? "dedicated endpoint" : "public sepolia.base.org"}`);
  console.log(`ESCROW_DEPLOY_BLOCK  ${deployBlock ?? "(unset — would fall back to genesis)"}`);
  console.log(`RPC_MAX_BLOCK_RANGE  ${maxRange}`);
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
    console.error("   no TaskResolved log found in that transaction — wrong tx or wrong escrow?");
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
  const from = deployBlock !== undefined ? BigInt(deployBlock) : 0n;

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
