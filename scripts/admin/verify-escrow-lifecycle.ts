/**
 * verify-escrow-lifecycle.ts — CC-082 acceptance, on Base Sepolia.
 *
 * Replaces test-dispute-lifecycle.ts, whose v1 flow (createTask -> disputeTask ->
 * resolveDispute) no longer compiles against the v2 ABI. Its CC-059 purpose — proving
 * `resolveDisputeOnChain` really works through the KMS signer now that the HSM key owns
 * the contract — is carried forward as phase `dispute` below.
 *
 * What this proves that the unit tests cannot: the KMS signer can produce a verdict
 * signature that a deployed contract accepts, and the whole path works against a real RPC
 * with real gas rather than an edr-simulated chain.
 *
 * ── Phases ──────────────────────────────────────────────────────────────────────
 *
 *   verdict    fund -> submitWork -> claimWithVerdict(passing).  One run, no waiting.
 *   dispute    fund -> submitWork -> disputeTask(failing verdict) -> resolveDisputeOnChain.
 *              One run. This is the CC-059 KMS proof.
 *   submit     fund -> submitWork, then stop and write state to a file.
 *   claim      resume from that file and call releaseAfterReview.
 *
 * `submit` and `claim` are split because MIN_REVIEW_WINDOW is 12 hours and
 * `releaseAfterReview` cannot be reached before it elapses. Run `submit`, come back
 * tomorrow, run `claim`. That pair is the acceptance criterion that matters most: **an
 * agent that does nothing after delivery cannot prevent the worker being paid.** Nothing
 * in the `claim` run touches the agent or the platform.
 *
 * ── Running ─────────────────────────────────────────────────────────────────────
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/admin/verify-escrow-lifecycle.ts verdict
 *
 * Costs ~1 USDC of testnet funds plus gas per run, and sends a little Sepolia ETH to a
 * throwaway worker key so it can pay for its own transactions — v2 payouts are
 * pull-payment, so the worker must be able to transact.
 *
 * Requires an active `gcloud auth application-default login --impersonate-service-account=...`
 * session (same one `npm run verify:kms` uses) for the phases that sign a verdict.
 *
 * If .env.local has ever picked up a VERCEL_OIDC_TOKEN (e.g. from `vercel link`), unset it
 * for this run — kms-signer.ts's isVercelRuntime() treats its mere presence as "running on
 * Vercel" and routes to the WIF path, which has no local credentials. See CC-066.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  formatEther,
  parseUnits,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CARBON_ESCROW_ABI } from "@/lib/contracts/escrow-abi";
import { toTaskId, getOnChainTask } from "@/lib/contracts/escrow";
import { resolveDisputeOnChain, getPlatformAccount } from "@/lib/contracts/signer";
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

const AMOUNT = parseUnits("1", 6); // 1 USDC
const REVIEW_WINDOW = 12 * 60 * 60; // MIN_REVIEW_WINDOW — the shortest legal wait
const DEADLINE_SECONDS = 24 * 60 * 60;
/** Enough for a handful of Base Sepolia transactions; the worker refunds nothing. */
const WORKER_GAS = parseEther("0.0005");

const STATE_FILE = resolve(process.cwd(), ".escrow-lifecycle-state.json");

interface PendingRun {
  phase: string;
  paymentRequestId: string;
  taskId: Hex;
  workerKey: Hex;
  workerAddress: Address;
  escrow: Address;
  specHash: Hex;
  evidenceHash: Hex;
  submittedAt: number;
  claimableAt: number;
}

/**
 * The public sepolia.base.org gateway has no read-your-writes guarantee across its
 * load-balanced backends (Lessons-Learned.md, CC-059's 2026-08-08 updates). A write can
 * revert on client-side gas estimation because the node handling THIS call has not caught
 * up to a prior write's block, even though that write already confirmed.
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

function hash32(): Hex {
  // Deterministic-per-run filler. The real specHash comes from CC-084's schema and the
  // real evidenceHash from CC-083's checker; neither exists yet, and the contract does
  // not care what is behind a commitment — only that it does not change.
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

const VERDICT_TYPES = {
  Verdict: [
    { name: "taskId", type: "bytes32" },
    { name: "specHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "checkerHash", type: "bytes32" },
    { name: "passed", type: "bool" },
    { name: "breakdownHash", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

interface Verdict {
  taskId: Hex;
  specHash: Hex;
  evidenceHash: Hex;
  checkerHash: Hex;
  passed: boolean;
  breakdownHash: Hex;
  expiry: bigint;
  nonce: bigint;
}

/**
 * Signs a verdict with the REAL platform signer — KMS in production, via the same
 * getPlatformAccount() the app uses. This is the half of Amendment 1 A1.1 that cannot be
 * proven off-chain: that the HSM's ECDSA output is something CarbonEscrow's ECDSA.recover
 * accepts, low-s normalisation and all.
 */
async function signVerdict(escrow: Address, verdict: Verdict): Promise<Hex> {
  const account = await getPlatformAccount();
  if (!account.signTypedData) {
    throw new Error("platform account cannot signTypedData — check kms-signer.ts");
  }
  return account.signTypedData({
    domain: {
      name: "CarbonEscrow",
      version: "2",
      chainId: baseSepolia.id,
      verifyingContract: escrow,
    },
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
  });
}

function verdictTuple(v: Verdict) {
  return {
    taskId: v.taskId,
    specHash: v.specHash,
    evidenceHash: v.evidenceHash,
    checkerHash: v.checkerHash,
    passed: v.passed,
    breakdownHash: v.breakdownHash,
    expiry: v.expiry,
    nonce: v.nonce,
  };
}

async function main() {
  const phase = (process.argv[2] ?? "").toLowerCase();
  const VALID = ["verdict", "dispute", "submit", "claim"];
  if (!VALID.includes(phase)) {
    console.error(`Usage: verify-escrow-lifecycle.ts <${VALID.join("|")}>`);
    console.error("\n  verdict   fund -> submit -> claimWithVerdict (one run)");
    console.error("  dispute   fund -> submit -> dispute -> resolveDispute via KMS (one run)");
    console.error("  submit    fund -> submitWork, then stop (writes state file)");
    console.error("  claim     resume and releaseAfterReview, 12h after `submit`");
    process.exitCode = 1;
    return;
  }

  const config = getConfig();
  const escrow = config.NEXT_PUBLIC_ESCROW_CONTRACT as Address;
  const usdc = config.NEXT_PUBLIC_USDC_ADDRESS as Address;
  if (!escrow) throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT not set");
  if (!usdc) throw new Error("NEXT_PUBLIC_USDC_ADDRESS not set");

  const rpcUrl = config.BASE_SEPOLIA_RPC_URL ?? baseSepolia.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  if (phase === "claim") {
    await runClaim(pub, rpcUrl, usdc, escrow);
    return;
  }

  const deployerKey = config.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY not set — needed to act as the test agent");
  }
  const agent = privateKeyToAccount(deployerKey as Hex);
  const agentWallet = createWalletClient({
    account: agent,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // The worker must be able to transact: v2 payouts are pull-payment, claimed by the
  // worker. A throwaway address with no key — which is what the v1 script used — cannot
  // call submitWork or releaseAfterReview at all.
  const workerKey = `0x${randomBytes(32).toString("hex")}` as Hex;
  const worker = privateKeyToAccount(workerKey);
  const workerWallet = createWalletClient({
    account: worker,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const paymentRequestId = randomBytes(16).toString("hex");
  const taskId = toTaskId(paymentRequestId);
  const specHash = hash32();
  const evidenceHash = hash32();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

  console.log(line());
  console.log(`CC-082 escrow lifecycle — phase "${phase}" — Base Sepolia`);
  console.log(line());
  console.log(`  escrow contract:     ${escrow}`);
  console.log(`  agent (deployer):    ${agent.address}`);
  console.log(`  worker (throwaway):  ${worker.address}`);
  console.log(`  payment_request_id:  ${paymentRequestId}`);
  console.log(`  taskId (bytes32):    ${taskId}`);
  console.log(`  amount:              1 USDC`);
  console.log(`  review window:       ${REVIEW_WINDOW}s (MIN_REVIEW_WINDOW)`);

  const workerUsdcBefore = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [worker.address],
  });

  // ── Fund the worker's gas ───────────────────────────────────────────────────
  console.log(`\n[gas] sending ${formatEther(WORKER_GAS)} ETH to the worker`);
  const gasHash = await agentWallet.sendTransaction({ to: worker.address, value: WORKER_GAS });
  await pub.waitForTransactionReceipt({ hash: gasHash });
  console.log(`      tx: ${gasHash}`);

  // ── approve + createTask ────────────────────────────────────────────────────
  console.log("\n[1] approve(escrow, 1 USDC) as agent");
  const approveHash = await agentWallet.writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [escrow, AMOUNT],
  });
  const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== "success") throw new Error(`approve reverted: ${approveHash}`);
  console.log(`      tx: ${approveHash}`);

  console.log("\n[2] createTask(taskId, worker, 1 USDC, deadline, reviewWindow, specHash) as agent");
  const createHash = await withRpcLagRetry("createTask", () =>
    agentWallet.writeContract({
      address: escrow,
      abi: CARBON_ESCROW_ABI,
      functionName: "createTask",
      args: [taskId, worker.address, AMOUNT, deadline, REVIEW_WINDOW, specHash],
    }),
  );
  const createReceipt = await pub.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") throw new Error(`createTask reverted: ${createHash}`);
  console.log(`      tx: ${createHash}`);

  // ── submitWork ──────────────────────────────────────────────────────────────
  console.log("\n[3] submitWork(taskId, evidenceHash, specVersionAck, 0) as WORKER");
  const submitHash = await withRpcLagRetry("submitWork", () =>
    workerWallet.writeContract({
      address: escrow,
      abi: CARBON_ESCROW_ABI,
      functionName: "submitWork",
      args: [taskId, evidenceHash, specHash, `0x${"00".repeat(32)}` as Hex],
    }),
  );
  const submitReceipt = await pub.waitForTransactionReceipt({ hash: submitHash });
  if (submitReceipt.status !== "success") throw new Error(`submitWork reverted: ${submitHash}`);
  console.log(`      tx: ${submitHash}`);

  const afterSubmit = await getOnChainTask(paymentRequestId);
  console.log(`      state: ${afterSubmit.state} (expected: Delivered)`);
  console.log(`      claimable at: ${new Date(Number(afterSubmit.reviewDeadline) * 1000).toISOString()}`);

  if (phase === "submit") {
    const pending: PendingRun = {
      phase: "submit",
      paymentRequestId,
      taskId,
      workerKey,
      workerAddress: worker.address,
      escrow,
      specHash,
      evidenceHash,
      submittedAt: Number(afterSubmit.submittedAt),
      claimableAt: Number(afterSubmit.reviewDeadline),
    };
    // The worker key is a throwaway holding testnet dust — but it is still a private key
    // in a file. .escrow-lifecycle-state.json is gitignored; delete it after claiming.
    writeFileSync(STATE_FILE, Buffer.from(JSON.stringify(pending, null, 2), "utf8"));

    console.log("\n" + line());
    console.log("PHASE 1 COMPLETE — work is delivered and the agent will now do nothing.");
    console.log(line());
    console.log(`\n  State written to ${STATE_FILE}`);
    console.log(`  Come back after ${new Date(pending.claimableAt * 1000).toLocaleString()} and run:`);
    console.log("\n    node --env-file=.env.local node_modules/tsx/dist/cli.mjs \\");
    console.log("      scripts/admin/verify-escrow-lifecycle.ts claim\n");
    return;
  }

  // ── Verdict phases ──────────────────────────────────────────────────────────
  const passed = phase === "verdict";
  const verdict: Verdict = {
    taskId,
    specHash,
    evidenceHash,
    checkerHash: hash32(),
    passed,
    breakdownHash: hash32(),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: BigInt(`0x${randomBytes(8).toString("hex")}`),
  };

  console.log(`\n[4] signing a ${passed ? "PASSING" : "FAILING"} verdict with the REAL platform signer`);
  const platformAccount = await getPlatformAccount();
  console.log(`      signer address: ${platformAccount.address}`);
  const signature = await signVerdict(escrow, verdict);
  console.log(`      signature: ${signature.slice(0, 20)}…`);

  const onChainDigest = await pub.readContract({
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "verdictDigest",
    args: [verdictTuple(verdict)],
  });
  console.log(`      contract digest: ${onChainDigest}`);

  if (passed) {
    console.log("\n[5] claimWithVerdict(taskId, verdict, signature) as WORKER");
    const claimHash = await withRpcLagRetry("claimWithVerdict", () =>
      workerWallet.writeContract({
        address: escrow,
        abi: CARBON_ESCROW_ABI,
        functionName: "claimWithVerdict",
        args: [taskId, verdictTuple(verdict), signature],
      }),
    );
    const claimReceipt = await pub.waitForTransactionReceipt({ hash: claimHash });
    console.log(`      tx: ${claimHash}  status: ${claimReceipt.status}`);

    await report(pub, usdc, paymentRequestId, worker.address, workerUsdcBefore, "Completed");
    return;
  }

  console.log("\n[5] disputeTask(taskId, failing verdict, signature) as AGENT");
  const disputeHash = await withRpcLagRetry("disputeTask", () =>
    agentWallet.writeContract({
      address: escrow,
      abi: CARBON_ESCROW_ABI,
      functionName: "disputeTask",
      args: [taskId, verdictTuple(verdict), signature],
    }),
  );
  const disputeReceipt = await pub.waitForTransactionReceipt({ hash: disputeHash });
  if (disputeReceipt.status !== "success") throw new Error(`disputeTask reverted: ${disputeHash}`);
  console.log(`      tx: ${disputeHash}`);

  console.log("\n[6] resolveDisputeOnChain(taskId, releaseToWorker=true) via the REAL platform signer");
  console.log("      (CC-059's proof — this is the exact function production calls, KMS-signed,");
  console.log("       and it only works because the HSM key owns the contract)");
  const resolveHash = await resolveDisputeOnChain(taskId, true);
  const resolveReceipt = await pub.waitForTransactionReceipt({ hash: resolveHash });
  console.log(`      tx: ${resolveHash}  status: ${resolveReceipt.status}`);

  await report(pub, usdc, paymentRequestId, worker.address, workerUsdcBefore, "Resolved");
}

/** Phase 2: the worker claims, with no agent or platform involvement whatsoever. */
async function runClaim(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pub: any,
  rpcUrl: string,
  usdc: Address,
  escrow: Address,
) {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`No pending run at ${STATE_FILE} — run the \`submit\` phase first.`);
  }
  const pending: PendingRun = JSON.parse(readFileSync(STATE_FILE, "utf8"));

  if (pending.escrow.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error(
      `State file is for escrow ${pending.escrow}, but NEXT_PUBLIC_ESCROW_CONTRACT is ${escrow}. ` +
        "The contract was redeployed since that run — start over.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  console.log(line());
  console.log("CC-082 escrow lifecycle — phase \"claim\" — Base Sepolia");
  console.log(line());
  console.log(`  taskId:       ${pending.taskId}`);
  console.log(`  worker:       ${pending.workerAddress}`);
  console.log(`  claimable at: ${new Date(pending.claimableAt * 1000).toISOString()}`);
  console.log(`  now:          ${new Date(now * 1000).toISOString()}`);

  if (now < pending.claimableAt) {
    const remaining = pending.claimableAt - now;
    console.log(
      `\n  The review window has ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m left. ` +
        "releaseAfterReview will revert with ReviewWindowOpen(). Come back later.",
    );
    process.exitCode = 1;
    return;
  }

  const worker = privateKeyToAccount(pending.workerKey);
  const workerWallet = createWalletClient({
    account: worker,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const before = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [worker.address],
  });

  console.log("\n[1] releaseAfterReview(taskId) as WORKER");
  console.log("    No agent action has occurred since delivery. No platform action either.");
  const hash = await withRpcLagRetry("releaseAfterReview", () =>
    workerWallet.writeContract({
      address: escrow,
      abi: CARBON_ESCROW_ABI,
      functionName: "releaseAfterReview",
      args: [pending.taskId],
    }),
  );
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`      tx: ${hash}  status: ${receipt.status}`);

  await report(pub, usdc, pending.paymentRequestId, worker.address, before, "Completed");
  console.log(`\n  Delete ${STATE_FILE} — it holds a throwaway private key.`);
}

async function report(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pub: any,
  usdc: Address,
  paymentRequestId: string,
  worker: Address,
  balanceBefore: bigint,
  expectedState: string,
) {
  console.log("\n" + line());
  console.log("VERIFICATION");
  console.log(line());

  let task = await getOnChainTask(paymentRequestId);
  if (task.state !== expectedState) {
    // Stale-read guard — same RPC lag as everywhere else. Re-check once before calling it
    // a failure.
    await new Promise((r) => setTimeout(r, 5000));
    task = await getOnChainTask(paymentRequestId);
  }
  console.log(`  on-chain state:  ${task.state} (expected: ${expectedState})`);
  console.log(`  evidenceHash:    ${task.evidenceHash}`);
  console.log(`  verdictHash:     ${task.verdictHash}`);
  console.log(`  verdictPassed:   ${task.verdictPassed}`);

  const after = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [worker],
  });
  const delta = (after as bigint) - balanceBefore;
  console.log(
    `  worker USDC:     ${formatUnits(balanceBefore, 6)} -> ${formatUnits(after as bigint, 6)} (delta ${formatUnits(delta, 6)})`,
  );

  const pass = task.state === expectedState && delta === AMOUNT;
  console.log(`\n  ${pass ? "PASS" : "FAIL"} — the worker ${pass ? "was paid" : "was NOT paid as expected"}.`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
});
