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
 *   dispute    fund -> submitWork -> disputeTask(failing verdict, AS AGENT)
 *              -> resolveDisputeOnChain(releaseToWorker=true). One run. The CC-059 KMS proof.
 *
 *   The three below close CC-079's stated gaps. Each is one run, same shape as `dispute`:
 *
 *   dispute-by-worker   the WORKER raises it. The contract always allowed either party
 *                       (ADR-0001 D2); nothing had ever exercised the worker side.
 *   dispute-refund      resolved as a REFUND to the agent. CC-059 only ever tested
 *                       release-to-worker, so this outcome has never run on any chain.
 *   arbitration-hold    raise the dispute and STOP, writing state. Pairs with:
 *   arbitration-claim   resume and call releaseAfterArbitration as the worker, once the
 *                       7-day window has elapsed with no ruling.
 *
 *   submit     fund -> submitWork, then stop and write state to a file.
 *   claim      resume from that file and call releaseAfterReview.
 *
 * ── Why arbitration is a split pair, like submit/claim ──────────────────────────
 *
 * ARBITRATION_WINDOW is 7 days and a live chain cannot be fast-forwarded. The contract
 * tests cover the boundary in both directions and are mutation-tested; what this pair adds
 * is the same property against real bytecode, real gas and a real week. Until the
 * 2026-09-01 redeploy it could not be run at all — no deployment had the clock.
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
import { signVerdict, verdictTuple, randomVerdictNonce, type Verdict } from "@/lib/contracts/verdict";
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

/**
 * Re-reads a task until the chain reports the expected state, or attempts run out.
 *
 * Polls for the value we expect rather than retrying on exception, because the failure mode
 * is a *successful* read returning the pre-write struct, not an error. `withRpcLagRetry`
 * above would not catch it — it only fires on a throw.
 */
async function pollForState(paymentRequestId: string, expected: string, attempts = 8) {
  let task = await getOnChainTask(paymentRequestId);
  for (let i = 1; i < attempts && task.state !== expected; i++) {
    console.log(`      chain still reports ${task.state}, re-reading in 5s (${i}/${attempts - 1})...`);
    await new Promise((r) => setTimeout(r, 5000));
    task = await getOnChainTask(paymentRequestId);
  }
  return task;
}

function hash32(): Hex {
  // Deterministic-per-run filler. The real specHash comes from CC-084's schema and the
  // real evidenceHash from CC-083's checker; neither exists yet, and the contract does
  // not care what is behind a commitment — only that it does not change.
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

async function main() {
  const phase = (process.argv[2] ?? "").toLowerCase();
  const VALID = [
    "verdict",
    "dispute",
    "dispute-by-worker",
    "dispute-refund",
    "arbitration-hold",
    "arbitration-claim",
    "submit",
    "claim",
  ];
  if (!VALID.includes(phase)) {
    console.error(`Usage: verify-escrow-lifecycle.ts <${VALID.join("|")}>`);
    console.error("\n  verdict             fund -> submit -> claimWithVerdict (one run)");
    console.error("  dispute             agent raises, owner releases to worker (CC-059 proof)");
    console.error("  dispute-by-worker   the WORKER raises it — never exercised before");
    console.error("  dispute-refund      owner REFUNDS the agent — never run on any chain");
    console.error("  arbitration-hold    raise a dispute and stop (writes state file)");
    console.error("  arbitration-claim   resume and releaseAfterArbitration, 7d after `hold`");
    console.error("  submit              fund -> submitWork, then stop (writes state file)");
    console.error("  claim               resume and releaseAfterReview, 12h after `submit`");
    process.exitCode = 1;
    return;
  }

  // Derived once, so the branches below read as intent rather than string comparison.
  const raisedByWorker = phase === "dispute-by-worker";
  const releaseToWorker = phase !== "dispute-refund";
  const holdForArbitration = phase === "arbitration-hold";

  const config = getConfig();
  const escrow = config.NEXT_PUBLIC_ESCROW_CONTRACT as Address;
  const usdc = config.NEXT_PUBLIC_USDC_ADDRESS as Address;
  if (!escrow) throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT not set");
  if (!usdc) throw new Error("NEXT_PUBLIC_USDC_ADDRESS not set");

  const rpcUrl = config.BASE_SEPOLIA_RPC_URL ?? baseSepolia.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  if (phase === "claim" || phase === "arbitration-claim") {
    await runResume(phase, pub, rpcUrl, usdc, escrow);
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

  // Poll, do not read once. On the first real run (2026-08-15) this read returned the
  // pre-submission struct — state Funded, submittedAt 0 — so reviewDeadline computed as
  // 43200, i.e. midday on 1 January 1970. Harmless in the verdict phase, but the submit
  // phase writes reviewDeadline into the state file, so the claim phase would have thought
  // the window had closed decades ago and reverted with ReviewWindowOpen().
  //
  // Lessons-Learned §16, for the fourth time in one morning — and this time in a script
  // written that same morning, by someone who had just finished writing the §16 recurrence
  // note. Knowing about a consistency bug does not protect you from it; only writing the
  // poll does.
  const afterSubmit = await pollForState(paymentRequestId, "Delivered");
  console.log(`      state: ${afterSubmit.state} (expected: Delivered)`);
  console.log(`      claimable at: ${new Date(Number(afterSubmit.reviewDeadline) * 1000).toISOString()}`);
  if (afterSubmit.state !== "Delivered") {
    throw new Error(
      `submitWork was mined (${submitHash}) but the chain still reports ${afterSubmit.state}. ` +
        "Refusing to continue on a read that may be stale — re-run, or check the tx on Basescan.",
    );
  }

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
    nonce: randomVerdictNonce(),
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

  // Either party may raise (ADR-0001 D2), and until now only the agent side had ever run.
  const raiser = raisedByWorker ? workerWallet : agentWallet;
  console.log(
    `\n[5] disputeTask(taskId, failing verdict, signature) as ${raisedByWorker ? "WORKER" : "AGENT"}`,
  );
  const disputeHash = await withRpcLagRetry("disputeTask", () =>
    raiser.writeContract({
      address: escrow,
      abi: CARBON_ESCROW_ABI,
      functionName: "disputeTask",
      args: [taskId, verdictTuple(verdict), signature],
    }),
  );
  const disputeReceipt = await pub.waitForTransactionReceipt({ hash: disputeHash });
  if (disputeReceipt.status !== "success") throw new Error(`disputeTask reverted: ${disputeHash}`);
  console.log(`      tx: ${disputeHash}`);

  if (holdForArbitration) {
    // Read the deadline off the contract rather than adding 7 days here. The window is a
    // constant in the bytecode, and the whole point of this phase is to test what the
    // deployment does — not what this script believes it does.
    const deadline = await withRpcLagRetry("arbitrationDeadline", () =>
      pub.readContract({
        address: escrow,
        abi: CARBON_ESCROW_ABI,
        functionName: "arbitrationDeadline",
        args: [taskId],
      }),
    );
    const pending: PendingRun = {
      phase: "arbitration-hold",
      paymentRequestId,
      taskId,
      workerKey,
      workerAddress: worker.address,
      escrow,
      specHash,
      evidenceHash,
      submittedAt: Math.floor(Date.now() / 1000),
      claimableAt: Number(deadline),
    };
    writeFileSync(STATE_FILE, Buffer.from(JSON.stringify(pending, null, 2), "utf8"));

    console.log("\n" + line());
    console.log("HOLD — the task is Disputed and the owner will now do nothing at all.");
    console.log(line());
    console.log("\n  This is the property ADR-0006 D3 exists for: an owner who never rules");
    console.log("  must not be able to hold the escrow forever. Nothing below this line");
    console.log("  involves the platform, the agent, or any ruling.");
    console.log(`\n  State written to ${STATE_FILE}`);
    console.log(`  Claimable from ${new Date(Number(deadline) * 1000).toLocaleString()} — run:`);
    console.log("\n    node --env-file=.env.local node_modules/tsx/dist/cli.mjs \\");
    console.log("      scripts/admin/verify-escrow-lifecycle.ts arbitration-claim");
    return;
  }

  const agentUsdcBefore = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [agent.address],
  });

  console.log(
    `\n[6] resolveDisputeOnChain(taskId, releaseToWorker=${releaseToWorker}) via the REAL platform signer`,
  );
  console.log("      (CC-059's proof — this is the exact function production calls, KMS-signed,");
  console.log("       and it only works because the HSM key owns the contract)");
  if (!releaseToWorker) {
    console.log("      REFUND outcome — CC-059 only ever tested release-to-worker, so this");
    console.log("      direction has never been executed against a real deployment.");
  }
  const resolveHash = await resolveDisputeOnChain(taskId, releaseToWorker);
  const resolveReceipt = await pub.waitForTransactionReceipt({ hash: resolveHash });
  console.log(`      tx: ${resolveHash}  status: ${resolveReceipt.status}`);

  // Report on the party the money actually reached. Reporting the worker's unchanged
  // balance as the headline is exactly what produced a FAIL on a correct refund run.
  if (releaseToWorker) {
    await report(pub, usdc, paymentRequestId, worker.address, workerUsdcBefore, "Resolved");
  } else {
    await report(pub, usdc, paymentRequestId, agent.address, agentUsdcBefore, "Resolved", {
      label: "agent",
    });
  }

  if (!releaseToWorker) {
    const agentAfter = await pub.readContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [agent.address],
    });
    const delta = (agentAfter as bigint) - (agentUsdcBefore as bigint);
    console.log(`\n  agent USDC delta: +${formatUnits(delta, 6)} — the refund landed with the funder.`);
    if (delta <= BigInt(0)) {
      throw new Error("refund resolved but the agent's USDC balance did not increase");
    }
  }
}

/** Phase 2: the worker claims, with no agent or platform involvement whatsoever. */
/**
 * Resume a held run — either `submit` -> `claim`, or `arbitration-hold` ->
 * `arbitration-claim`. One function because the setup, the guards and the reporting are
 * identical; only the contract call and the reason for waiting differ.
 */
async function runResume(
  phase: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pub: any,
  rpcUrl: string,
  usdc: Address,
  escrow: Address,
) {
  const arbitration = phase === "arbitration-claim";
  const expectedHold = arbitration ? "arbitration-hold" : "submit";
  const fn = arbitration ? "releaseAfterArbitration" : "releaseAfterReview";

  if (!existsSync(STATE_FILE)) {
    throw new Error(`No pending run at ${STATE_FILE} — run the \`${expectedHold}\` phase first.`);
  }
  const pending: PendingRun = JSON.parse(readFileSync(STATE_FILE, "utf8"));

  if (pending.escrow.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error(
      `State file is for escrow ${pending.escrow}, but NEXT_PUBLIC_ESCROW_CONTRACT is ${escrow}. ` +
        "The contract was redeployed since that run — start over.",
    );
  }

  // The two holds write the same file, and resuming the wrong one reverts inside the
  // contract with a state error that says nothing about which phase you meant. Caught here
  // instead, by name.
  if (pending.phase !== expectedHold) {
    throw new Error(
      `State file holds a "${pending.phase}" run, but "${phase}" resumes "${expectedHold}". ` +
        `Calling ${fn} on that task would revert on state, which reads as a contract fault ` +
        "rather than the wrong command.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  console.log(line());
  console.log(`CC-082 escrow lifecycle — phase "${phase}" — Base Sepolia`);
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

/**
 * @param payee      Who the run expects the escrowed USDC to reach.
 * @param expectPaid Whether `payee` should have gained AMOUNT. False for the refund phase,
 *   where the worker correctly ends up with nothing.
 *
 * This parameter exists because the first `dispute-refund` run printed
 * **"FAIL - the worker was NOT paid as expected"** on a run that was entirely correct: the
 * refund had landed with the agent, exactly as intended. This function carried one
 * hard-coded expectation - the worker gains AMOUNT - from when every phase paid the worker.
 *
 * A correct run that prints FAIL is worse than a silent one. It trains the reader to
 * discount the verdict line, and anyone reading that output cold would conclude the refund
 * path is broken when it is the only thing that has ever proved it works.
 */
async function report(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pub: any,
  usdc: Address,
  paymentRequestId: string,
  payee: Address,
  balanceBefore: bigint,
  expectedState: string,
  opts: { label?: string; expectPaid?: boolean } = {},
) {
  const label = opts.label ?? "worker";
  const expectPaid = opts.expectPaid ?? true;
  console.log("\n" + line());
  console.log("VERIFICATION");
  console.log(line());

  const task = await pollForState(paymentRequestId, expectedState);
  console.log(`  on-chain state:  ${task.state} (expected: ${expectedState})`);
  console.log(`  evidenceHash:    ${task.evidenceHash}`);
  console.log(`  verdictHash:     ${task.verdictHash}`);
  console.log(`  verdictPassed:   ${task.verdictPassed}`);

  const after = await pub.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [payee],
  });
  const delta = (after as bigint) - balanceBefore;
  const pad = " ".repeat(Math.max(1, 13 - label.length));
  console.log(
    `  ${label} USDC:${pad}${formatUnits(balanceBefore, 6)} -> ${formatUnits(after as bigint, 6)} (delta ${formatUnits(delta, 6)})`,
  );

  // A refund is correct precisely when the payee under test gained nothing.
  const moved = expectPaid ? delta === AMOUNT : delta === BigInt(0);
  const pass = task.state === expectedState && moved;

  if (pass) {
    console.log(
      `\n  PASS — ${expectPaid ? `the ${label} was paid` : `the ${label} correctly received nothing`}.`,
    );
  } else if (task.state !== expectedState) {
    console.log(`\n  FAIL — on-chain state is ${task.state}, expected ${expectedState}.`);
  } else if (expectPaid) {
    console.log(`\n  FAIL — the ${label} was NOT paid as expected.`);
  } else {
    console.log(
      `\n  FAIL — the ${label} gained ${formatUnits(delta, 6)} USDC on a run where they` +
        " should have gained nothing.",
    );
  }
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
});
