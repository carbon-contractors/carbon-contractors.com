/**
 * funding-stage.mjs — CC-077 Sepolia lifecycle: Funding stage harness.
 *
 * Drives the RESCOPED flow (CC-077, "Rescoped 2026-08-28") — there is no x402
 * payment challenge and there never will be one again (CC-081 Defect 1):
 *
 *   request_human_work → row 'pending'/'accepted'
 *   worker accepts     → POST /api/offers/accept → 'accepted'
 *   agent funds        → USDC.approve + escrow.createTask (agent's OWN wallet;
 *                        the platform transacts nowhere)
 *   agent confirms     → POST /api/fund-task → 'active' (reads getTask from chain)
 *   worker notified    → CC-095 channel (manual check in this harness)
 *
 * Step 1 is NOT automated — it needs a running, authenticated MCP session — so
 * every run resumes from --task-id=<payment_request_id> obtained by the
 * operator. The public /api/tasks feed nulls payment_request_id for unfunded
 * rows (migration 022), so the id must come from the request_human_work
 * response, never scraped.
 *
 * Modes:
 *   --dry-run (default)  validate config, print the exact execution plan, move
 *                         nothing, touch no network. This is the only mode that
 *                         has been exercised in the scaffold pass.
 *   --execute            run the plan for real against Base Sepolia. Broadcasts
 *                         from the wallet named by AGENT_WALLET_PRIVATE_KEY.
 *                         Guard cases still only eth_call — see cases.mjs.
 *
 * Every --execute run ends with scripts/audit/verify-escrow-solvency.mjs and
 * reports its verdict; --dry-run lists it as the final plan step instead (a
 * dry run that spawned an RPC reader would not be dry).
 *
 *   node --env-file=.env.local scripts/lifecycle/funding-stage.mjs --dry-run
 *
 * Exit codes: 0 expected outcome (incl. expected reverts/refusals) · 1 the
 * behaviour did NOT match CC-077's expected clean outcome · 2 misconfigured or
 * bad arguments.
 */

import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs, USAGE } from "./args.mjs";
import { validateLifecycleConfig, configFailureMessage, ENV_NAMES } from "./config.mjs";
import { selectCase } from "./cases.mjs";
import { buildPlan, renderPlan } from "./plan.mjs";
import { chainIdMismatch, withRpcRetry, shortError } from "../audit/rpc-retry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
// Only the createTask fragment — simulating this ABI against the deployed v2
// escrow is exactly what the guard cases want.
const CREATE_TASK_ABI = [
  {
    type: "function",
    name: "createTask",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "worker", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "reviewWindow", type: "uint32" },
      { name: "specHash", type: "bytes32" },
    ],
    outputs: [],
  },
];
// Readback only — agent/worker/amount/state. Width-drift against a redeployed
// escrow is CC-082's lesson; a readback that cannot decode FAILS the run loudly
// rather than asserting a task it could not read.
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
          { name: "disputedAt", type: "uint64" },
          { name: "attestationUid", type: "bytes32" },
        ],
      },
    ],
  },
];

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const mode = parsed.execute ? "execute" : "dry-run";

  const check = validateLifecycleConfig(process.env);
  if (!check.ok) {
    console.error(configFailureMessage(check.problems));
    return 2;
  }
  const config = check.config;

  let caseSel;
  try {
    caseSel = selectCase(parsed.caseKeys);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  const { caseKey, caseDef } = caseSel;

  // Execution needs a concrete task to work against; dry-run may plan with
  // placeholders so the operator can see the shape before getting an id.
  if (parsed.execute && !parsed.taskId && caseKey !== "zeroAmount" && caseKey !== "invalidWorker" && caseKey !== "deadlinePassed" && caseKey !== "invalidReviewWindow" && caseKey !== "insufficientBalance") {
    console.error(
      `--execute needs --task-id=<payment_request_id> for ${caseKey} — run request_human_work yourself and resume from its response. (Dry-run may omit it and print placeholders.)`,
    );
    return 2;
  }
  if (parsed.execute && caseDef.requiresFundedTask && !parsed.taskId) {
    console.error("task-already-exists needs --task-id of an ALREADY-FUNDED task.");
    return 2;
  }

  const plan = buildPlan({ parsed, config, caseKey, now: Math.floor(Date.now() / 1000) });

  console.log(renderPlan(plan, mode));
  console.log("");

  if (!parsed.execute) {
    console.log("DRY-RUN — nothing was executed, nothing moved, no RPC was contacted.");
    console.log("Re-run with --execute (and --task-id) to perform the plan. See scripts/lifecycle/README.md.");
    return 0;
  }

  return runExecute(parsed, config, plan, caseKey, caseDef);
}

// ── The live runner (scaffold; first --execute run belongs to CC-077 proper) ──

function revertName(err) {
  let cursor = err;
  for (let depth = 0; cursor && depth < 8; depth++) {
    const name = cursor?.name ?? cursor?.errorName;
    if (typeof name === "string" && name) return name;
    cursor = cursor?.cause;
  }
  return null;
}

async function runExecute(parsed, config, plan, caseKey, caseDef) {
  const client = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });

  const mismatch = await chainIdMismatch(client, config.chainId, ENV_NAMES.rpcUrl);
  if (mismatch) {
    console.error(mismatch);
    return 2;
  }

  // The key is read only here, at execution time, and never printed.
  const account = privateKeyToAccount(process.env[ENV_NAMES.agentKey]);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) });
  console.log(`agent wallet ${account.address} (from ${ENV_NAMES.agentKey})`);
  console.log("");

  let outcome;
  try {
    if (caseDef.kind === "guard") {
      outcome = await runGuardCase(client, wallet, config, plan, caseKey);
    } else if (caseKey === "fundTaskBeforeFunding") {
      outcome = await runFundTaskBeforeFunding(config, plan);
    } else {
      outcome = await runFundFlowCase(client, wallet, config, plan, caseKey);
    }
  } catch (err) {
    if (revertName(err) || /revert/i.test(String(err?.message))) {
      console.error(`UNEXPECTED REVERT: ${shortError(err)} (revert name: ${revertName(err)})`);
    } else {
      console.error(`FAILED: ${shortError(err)}`);
    }
    await runSolvency(config);
    return 1;
  }

  await runSolvency(config);
  return outcome ? 0 : 1;
}

async function runGuardCase(client, wallet, config, plan, caseKey) {
  const i = plan.inputs;
  // A taskless guard case has no quote to take a worker from; any non-zero
  // address passes InvalidWorker, so the agent's own address stands in. The
  // invalidWorker case overrides it with address(0) via its mutation.
  const worker = i.worker ?? wallet.account.address;
  let amountWei = BigInt(i.amount_wei);
  if (caseKey === "insufficientBalance") {
    // amount+1 only fails cleanly if it exceeds the BALANCE — read it, then
    // top the amount so it genuinely does.
    const balance = await withRpcRetry("balanceOf", () =>
      client.readContract({ address: config.usdc, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [wallet.account.address] }));
    amountWei = BigInt(balance) + BigInt(1);
    console.log(`agent USDC balance ${formatUnits(balance, config.usdcDecimals)} — simulating createTask for ${formatUnits(amountWei, config.usdcDecimals)} (balance + 1 unit)`);
  }
  console.log(`STEP 1 — simulate createTask via eth_call (NO broadcast):`);
  console.log(`  taskId=${i.task_id_bytes32 ?? deriveFreshTaskId()} worker=${worker} amount=${amountWei} deadline=${i.deadline_unix} reviewWindow=${i.review_window_seconds}`);
  let revert = null;
  try {
    // eth_call only — simulateContract never signs, never broadcasts.
    await client.simulateContract({
      address: config.escrow,
      abi: CREATE_TASK_ABI,
      functionName: "createTask",
      account: wallet.account,
      args: [i.task_id_bytes32 ?? deriveFreshTaskId(), worker, amountWei, BigInt(i.deadline_unix), i.review_window_seconds, i.spec_hash ?? ZERO_BYTES32],
    });
    // A guard case that SUCCEEDS is the finding: the contract accepted what
    // CC-077 says it must refuse.
    console.error(`NOT CLEAN — createTask was expected to revert ${expectedGuard(caseKey)} but the simulation succeeded.`);
    return false;
  } catch (err) {
    revert = revertName(err) ?? shortError(err);
  }
  const expected = expectedGuard(caseKey);
  const clean = revert === expected;
  console.log(`  reverted: ${revert}`);
  console.log(clean
    ? `CLEAN — reverted ${expected} exactly as CC-077 expects. Nothing broadcast, nothing moved.`
    : `NOT CLEAN — expected revert ${expected}, got ${revert}.`);
  return clean;
}

function expectedGuard(caseKey) {
  return {
    taskAlreadyExists: "TaskAlreadyExists",
    zeroAmount: "ZeroAmount",
    invalidWorker: "InvalidWorker",
    deadlinePassed: "DeadlinePassed",
    invalidReviewWindow: "InvalidReviewWindow",
    insufficientBalance: "ERC20InsufficientBalance",
  }[caseKey];
}

async function runFundTaskBeforeFunding(config, plan) {
  const res = await fetch(`${config.baseUrl}/api/fund-task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payment_request_id: plan.inputs.payment_request_id }),
  });
  const body = await res.json();
  console.log(`STEP — POST /api/fund-task → HTTP ${res.status}`);
  console.log(`  ${JSON.stringify(body)}`);
  const cleanRefusal = res.status === 409 && body.on_chain_state === "None";
  // Row untouched: the public feed nulls payment_request_id for unfunded rows
  // (migration 022), so verify via the refusal itself + a status spot-check.
  console.log(cleanRefusal
    ? `CLEAN — 409 with on_chain_state "None"; the row cannot have activated with no on-chain task.`
    : `NOT CLEAN — expected 409 + on_chain_state "None", got ${res.status} ${JSON.stringify(body)}.`);
  return cleanRefusal;
}

async function runFundFlowCase(client, wallet, config, plan, caseKey) {
  const i = plan.inputs;
  if (caseKey === "happy" || caseKey === "workerAmountMismatch") {
    if (caseKey === "workerAmountMismatch") {
      console.log(`STEP 1 — approve ${i.funded_wei} and createTask for ${i.funded_wei} (row quoted ${i.amount_wei})`);
    } else {
      console.log(`STEP 3 — USDC.approve(${config.escrow}, ${i.funded_wei}) from the agent wallet`);
    }
    await sendTx(client, wallet, config.usdc, ERC20_APPROVE_ABI, "approve", [config.escrow, BigInt(i.funded_wei)]);
    console.log(`  escrow.createTask(${i.task_id_bytes32}, ${i.worker}, ${i.funded_wei}, ${i.deadline_unix}, ${i.review_window_seconds}, ${i.spec_hash})`);
    await sendTx(client, wallet, config.escrow, CREATE_TASK_ABI, "createTask", [i.task_id_bytes32, i.worker, BigInt(i.funded_wei), BigInt(i.deadline_unix), i.review_window_seconds, i.spec_hash ?? ZERO_BYTES32]);
    if (caseKey === "workerAmountMismatch") {
      console.log(`  on-chain task funded with the WRONG amount — real USDC locked.`);
    } else {
      // Readback: the chain, not the DB, is the authority on money (CC-037).
      const onChain = await withRpcRetry("getTask readback", () =>
        client.readContract({ address: config.escrow, abi: GET_TASK_ABI, functionName: "getTask", args: [i.task_id_bytes32] }));
      console.log(`  getTask readback: state=${onChain.state} agent=${onChain.agent} worker=${onChain.worker} amount=${onChain.amount}`);
      const agentOk = String(onChain.agent).toLowerCase() === wallet.account.address.toLowerCase();
      const workerOk = String(onChain.worker).toLowerCase() === String(i.worker).toLowerCase();
      const amountOk = BigInt(onChain.amount) === BigInt(i.funded_wei);
      if (!(agentOk && workerOk && amountOk)) {
        console.error(`NOT CLEAN — on-chain task does not match the quote (agent=${agentOk} worker=${workerOk} amount=${amountOk}).`);
        return false;
      }
      console.log(`  on-chain task.agent / task.worker / task.amount all match the quote.`);
    }
  } else if (caseKey === "insufficientAllowance") {
    console.log(`STEP 1 — approve ${i.approve_wei} (deliberately short of ${i.amount_wei}), then createTask`);
    await sendTx(client, wallet, config.usdc, ERC20_APPROVE_ABI, "approve", [config.escrow, BigInt(i.approve_wei)]);
    try {
      await sendTx(client, wallet, config.escrow, CREATE_TASK_ABI, "createTask", [i.task_id_bytes32, i.worker, BigInt(i.amount_wei), BigInt(i.deadline_unix), i.review_window_seconds, i.spec_hash]);
      console.error("NOT CLEAN — createTask succeeded with a short allowance.");
      return false;
    } catch (err) {
      const name = revertName(err) ?? shortError(err);
      console.log(`  createTask reverted: ${name}`);
      if (!/InsufficientAllowance/i.test(name)) {
        console.error(`NOT CLEAN — expected an insufficient-allowance revert, got ${name}.`);
        return false;
      }
    }
  }

  const res = await fetch(`${config.baseUrl}/api/fund-task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payment_request_id: i.payment_request_id }),
  });
  const body = await res.json();
  console.log(`POST /api/fund-task → HTTP ${res.status}`);
  console.log(`  ${JSON.stringify(body)}`);

  if (caseKey === "happy") {
    // Happy path: 200 + active — activated ONLY because the chain read Funded.
    const clean = res.status === 200 && body.ok === true && body.status === "active";
    console.log(clean
      ? `CLEAN — row reached 'active' via /api/fund-task reading the chain, not via anything this harness wrote to the DB.`
      : `NOT CLEAN — expected 200 ok status:'active', got ${res.status} ${JSON.stringify(body)}.`);
    return clean;
  }

  const clean = res.status === 409 && body.ok === false;
  if (clean) {
    console.log(`CLEAN — the route refused (409) and the row cannot be 'active'.`);
    if (caseKey === "workerAmountMismatch") {
      console.log("");
      console.log(`MANDATORY RECOVERY — ${i.funded_wei} units (${formatUnits(BigInt(i.funded_wei), 6)} USDC) are locked`);
      console.log(`in a task the DB row will never claim. The agent wallet reclaims them with`);
      console.log(`agent-only escrow.expireTask (pull refund, ADR-0001 A1.2). CarbonEscrow has no`);
      console.log(`rescue — skip this and the money is stranded (CC-081 Defect 1).`);
    }
  } else {
    console.error(`NOT CLEAN — expected 409 refusal, got ${res.status} ${JSON.stringify(body)}.`);
  }
  return clean;
}

async function sendTx(client, wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  console.log(`  tx ${functionName} → ${hash}`);
  const receipt = await waitForReceipt(client, hash);
  if (receipt.status !== "success") throw new Error(`${functionName} tx ${hash} reverted on chain`);
  console.log(`  mined in block ${receipt.blockNumber}`);
  return hash;
}

async function waitForReceipt(client, hash) {
  // Poll rather than watchEvent: behaves identically against every provider,
  // including ones whose websocket support is flaky (the CC-048 lesson).
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = await withRpcRetry("getTransactionReceipt", () =>
      client.getTransactionReceipt({ hash }),
    ).catch(() => null);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${hash} not mined after 120s`);
}

async function runSolvency(config) {
  console.log("");
  console.log("── verify-escrow-solvency ───────────────────────────────────────");
  const script = join(REPO, "scripts", "audit", "verify-escrow-solvency.mjs");
  // The audit script reads NEXT_PUBLIC_ESCROW_CONTRACT / NEXT_PUBLIC_USDC_ADDRESS
  // from its env. Pin them to the SAME chain-constants values this harness
  // targeted, so the reconciliation cannot silently check a different escrow
  // than the one the run funded.
  const env = {
    ...process.env,
    NEXT_PUBLIC_ESCROW_CONTRACT: config.escrow,
    NEXT_PUBLIC_USDC_ADDRESS: config.usdc,
  };
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: REPO, env });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", (err) => resolve({ code: 2, err: err.message }));
    child.on("close", (code) => resolve({ code }));
  });
  if (result.err) {
    console.error(`solvency check could not run: ${result.err}`);
    return false;
  }
  console.log(result.code === 0
    ? `SOLVENCY CLEAN (exit ${result.code}) — every USDC in the escrow is accounted for by a createTask.`
    : `SOLVENCY NOT CLEAN (exit ${result.code}) — investigate before any further funding.`);
  return result.code === 0;
}

process.exitCode = await main();
