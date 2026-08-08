/**
 * test-dispute-lifecycle.ts — CC-059 step 3.
 *
 * End-to-end proof that `resolveDisputeOnChain` (src/lib/contracts/signer.ts) actually
 * works now that CarbonEscrow.owner() is the KMS/HSM address. This calls the REAL
 * production function — not a reimplementation — so it exercises the exact code path
 * a live dispute resolution would take, including the GCP KMS signing in kms-signer.ts.
 *
 * Funds a real task, disputes it, then resolves it via the platform signer:
 *   createTask (agent = DEPLOYER key, standing in for a real agent wallet)
 *     -> disputeTask (agent)
 *     -> resolveDisputeOnChain (platform signer — KMS, now the contract owner)
 *   Verifies the worker's USDC balance increased by the escrowed amount and
 *   the on-chain task state is Resolved.
 *
 * Uses 1 USDC and Base Sepolia testnet funds only. Run with:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/admin/test-dispute-lifecycle.ts
 *
 * Requires an active `gcloud auth application-default login --impersonate-service-account=...`
 * session (same one used by `npm run verify:kms`) since GCP_KMS_KEY_PATH is set locally.
 *
 * If `.env.local` has ever picked up a `VERCEL_OIDC_TOKEN` (e.g. from `vercel link`), unset it
 * for this run — kms-signer.ts's isVercelRuntime() treats its mere presence as "running on
 * Vercel" and routes to the WIF path, which has no local credentials to use. See CC-066.
 */

import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CARBON_ESCROW_ABI } from "@/lib/contracts/escrow-abi";
import { toTaskId, getOnChainTask } from "@/lib/contracts/escrow";
import { resolveDisputeOnChain } from "@/lib/contracts/signer";
import { getConfig } from "@/lib/config";

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const line = (n = 74) => "=".repeat(n);

/**
 * The public sepolia.base.org RPC gateway has no read-your-writes guarantee across its
 * load-balanced backend nodes (see Lessons-Learned.md, CC-059's 2026-08-08 updates). A write
 * can revert on client-side gas estimation because the node handling THIS call hasn't caught up
 * to a prior write's block yet, even though that prior write already confirmed. Retry rather
 * than fail outright.
 */
async function withRpcLagRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`      ${label} attempt ${attempt} failed (likely RPC lag), retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("unreachable");
}

async function main() {
  const config = getConfig();
  const escrow = config.NEXT_PUBLIC_ESCROW_CONTRACT as Address;
  const usdc = config.NEXT_PUBLIC_USDC_ADDRESS as Address;
  if (!escrow) throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT not set");
  if (!usdc) throw new Error("NEXT_PUBLIC_USDC_ADDRESS not set");

  const rpcUrl = config.BASE_SEPOLIA_RPC_URL ?? baseSepolia.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const deployerKey = config.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set — needed to act as the test agent");
  const agent = privateKeyToAccount(deployerKey as `0x${string}`);
  const agentWallet = createWalletClient({ account: agent, chain: baseSepolia, transport: http(rpcUrl) });

  // Fresh throwaway address as "worker" — never signs anything in this flow.
  const worker = privateKeyToAccount(("0x" + randomBytes(32).toString("hex")) as `0x${string}`).address;

  const amount = parseUnits("1", 6); // 1 USDC
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const paymentRequestId = randomBytes(16).toString("hex");
  const taskId = toTaskId(paymentRequestId);

  console.log(line());
  console.log("CC-059 dispute lifecycle test — Base Sepolia");
  console.log(line());
  console.log(`  escrow contract:     ${escrow}`);
  console.log(`  agent (deployer):    ${agent.address}`);
  console.log(`  worker (throwaway):  ${worker}`);
  console.log(`  payment_request_id:  ${paymentRequestId}`);
  console.log(`  taskId (bytes32):    ${taskId}`);
  console.log(`  amount:              1 USDC`);

  const workerBalanceBefore = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [worker],
  });

  console.log("\n[1/4] approve(escrow, 1 USDC) as agent");
  const approveHash = await agentWallet.writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [escrow, amount],
  });
  const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== "success") throw new Error(`approve reverted on-chain: ${approveHash}`);
  console.log(`      tx: ${approveHash}`);

  console.log("\n[2/4] createTask(taskId, worker, 1 USDC, deadline) as agent");
  const createHash = await agentWallet.writeContract({
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "createTask",
    args: [taskId, worker, amount, deadline],
  });
  const createReceipt = await pub.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") throw new Error(`createTask reverted on-chain: ${createHash}`);
  console.log(`      tx: ${createHash}`);

  console.log("\n[3/4] disputeTask(taskId) as agent");
  const disputeHash = await withRpcLagRetry("disputeTask", () =>
    agentWallet.writeContract({
      address: escrow,
      abi: CARBON_ESCROW_ABI,
      functionName: "disputeTask",
      args: [taskId],
    }),
  );
  const disputeReceipt = await pub.waitForTransactionReceipt({ hash: disputeHash });
  if (disputeReceipt.status !== "success") throw new Error(`disputeTask reverted on-chain: ${disputeHash}`);
  console.log(`      tx: ${disputeHash}`);

  console.log("\n[4/4] resolveDisputeOnChain(taskId, releaseToWorker=true) via REAL platform signer");
  console.log("      (this is the exact function production calls — KMS-signed, since the");
  console.log("       contract owner is now the HSM address)");
  const resolveHash = await resolveDisputeOnChain(taskId, true);
  const resolveReceipt = await pub.waitForTransactionReceipt({ hash: resolveHash });
  console.log(`      tx: ${resolveHash}`);
  console.log(`      status: ${resolveReceipt.status}`);

  console.log("\n" + line());
  console.log("VERIFICATION");
  console.log(line());

  let onChainTask = await getOnChainTask(paymentRequestId);
  if (onChainTask.state !== "Resolved") {
    // Same stale-read pattern as above — re-check once before concluding it's a real failure.
    await new Promise((r) => setTimeout(r, 5000));
    onChainTask = await getOnChainTask(paymentRequestId);
  }
  console.log(`  on-chain task state: ${onChainTask.state} (expected: Resolved)`);

  const workerBalanceAfter = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [worker],
  });
  const delta = workerBalanceAfter - workerBalanceBefore;
  console.log(`  worker USDC balance: ${formatUnits(workerBalanceBefore, 6)} -> ${formatUnits(workerBalanceAfter, 6)} (delta ${formatUnits(delta, 6)})`);

  const pass = onChainTask.state === "Resolved" && delta === amount && resolveReceipt.status === "success";
  console.log(`\n  ${pass ? "PASS" : "FAIL"} — resolveDisputeOnChain ${pass ? "works end-to-end via the KMS signer." : "did NOT behave as expected."}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
});
