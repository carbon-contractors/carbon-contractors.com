/**
 * expire-task.ts — one-off: call CarbonEscrow.expireTask as the funding agent.
 *
 * `expireTask` is agent-only (ADR-0001 A1.2) and, unlike the worker's claims, it PAYS
 * OUT in the same transaction: Funded -> Expired, `totalLocked -= amount`, USDC sent
 * straight back to `task.agent`. Nothing in the app, MCP or dashboard can call it, and the
 * platform signer would revert `NotAgent()`, so a task whose worker never delivered stays
 * `Funded` and locked until the agent's own wallet sends this transaction (CC-080).
 *
 * This is the escape hatch for the Sepolia test task that lapsed on 2026-09-01. It is
 * not a product surface.
 *
 * Dry run by default: reads the task, prints every precondition the contract will check
 * and whether it holds, and sends nothing. CONFIRM=true sends the transaction.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/admin/expire-task.ts <payment_request_id>
 *
 *   CONFIRM=true node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/admin/expire-task.ts <payment_request_id>
 *
 * `<payment_request_id>` is the tasks.payment_request_id column, not the bytes32 taskId.
 * The sender is DEPLOYER_PRIVATE_KEY and must be the task's agent.
 *
 * If a variable in .env.local has also been set in the shell, the shell wins silently
 * (see CLAUDE.md, "node --env-file does not override").
 */

import { createPublicClient, createWalletClient, http, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CARBON_ESCROW_ABI } from "@/lib/contracts/escrow-abi";
import { toTaskId, getOnChainTask } from "@/lib/contracts/escrow";
import { getConfig } from "@/lib/config";

async function main() {
  const paymentRequestId = process.argv[2];
  if (!paymentRequestId || paymentRequestId.startsWith("0x")) {
    console.error("usage: expire-task.ts <payment_request_id>   (not the bytes32 taskId)");
    process.exitCode = 1;
    return;
  }
  const confirm = process.env.CONFIRM === "true";

  const config = getConfig();
  const escrow = config.NEXT_PUBLIC_ESCROW_CONTRACT as Address;
  if (!escrow) throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT not set");
  const deployerKey = config.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set — needed to act as the agent");

  const rpcUrl = config.BASE_SEPOLIA_RPC_URL ?? baseSepolia.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const account = privateKeyToAccount(deployerKey as Hex);

  const taskId = toTaskId(paymentRequestId);
  const task = await getOnChainTask(paymentRequestId);
  if (!task) throw new Error(`No on-chain task for payment_request_id ${paymentRequestId}`);

  const block = await pub.getBlock();
  const now = Number(block.timestamp);
  const deadline = Number(task.deadline);

  const isFunded = task.state === "Funded";
  const isAgent = task.agent.toLowerCase() === account.address.toLowerCase();
  const isPastDeadline = now >= deadline;

  console.log(`escrow      ${escrow}`);
  console.log(`taskId      ${taskId}`);
  console.log(`state       ${task.state}`);
  console.log(`amount      ${formatUnits(task.amount, 6)} USDC`);
  console.log(`agent       ${task.agent}`);
  console.log(`sender      ${account.address}`);
  console.log(`deadline    ${new Date(deadline * 1000).toISOString()}  (chain time ${new Date(now * 1000).toISOString()})`);
  console.log("");
  console.log(`  ${isFunded ? "ok  " : "FAIL"} state is Funded (expireTask is unreachable once Delivered)`);
  console.log(`  ${isAgent ? "ok  " : "FAIL"} sender is the task's agent (NotAgent otherwise)`);
  console.log(`  ${isPastDeadline ? "ok  " : "FAIL"} deadline has passed (NotExpired otherwise)`);

  if (!isFunded || !isAgent || !isPastDeadline) {
    console.error("\nexpireTask would revert; not sending.");
    process.exitCode = 1;
    return;
  }

  // Simulate first so a revert reads as a decoded name, not a failed broadcast.
  await pub.simulateContract({
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "expireTask",
    args: [taskId],
    account,
  });

  if (!confirm) {
    console.log("\nDRY RUN — simulation passed. Re-run with CONFIRM=true to send expireTask.");
    return;
  }

  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "expireTask",
    args: [taskId],
  });
  console.log(`\nsent        ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`expireTask reverted in block ${receipt.blockNumber}`);

  const after = await getOnChainTask(paymentRequestId);
  console.log(`state now   ${after?.state}   (expected Expired)`);
  console.log("The refund was paid to the agent in the same transaction.");
  console.log("Run verify-escrow-solvency.mjs to confirm balance == totalLocked.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
