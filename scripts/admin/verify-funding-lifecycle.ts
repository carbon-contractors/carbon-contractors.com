/**
 * verify-funding-lifecycle.ts — CC-077, the funding stage, through the product.
 *
 * `verify-escrow-lifecycle.ts` proves the *contract*. It talks straight to the chain and
 * never touches an API. This proves the **product**: MCP, the offer stage, and
 * `/api/fund-task` — the things an agent actually uses, none of which that script exercises.
 *
 * ── Phases ──────────────────────────────────────────────────────────────────────
 *
 *   offer   authenticate as the agent, `request_human_work`, and assert that
 *           `/api/fund-task` REFUSES the resulting row. Writes state, then stops.
 *   fund    after the worker has accepted in the dashboard: USDC.approve +
 *           escrow.createTask from the agent's own wallet, then confirm.
 *
 * Split because the middle step is a human accepting an offer in a browser, and that is
 * the point rather than an inconvenience. A script POSTing `/api/offers/accept` would
 * prove the endpoint works; it would not prove a worker can consent, which is what
 * `ADR-0005` D2 and `CC-094` are about.
 *
 * ── What each phase is really testing ───────────────────────────────────────────
 *
 * **Money must not move before the offer clears.** With `accepts_auto_booking` false the
 * row is born `pending`, and `/api/fund-task` must refuse it. The `offer` phase asserts
 * that refusal rather than assuming it — an offer stage that silently accepts funding is
 * indistinguishable from one that works, right up until a worker is booked without consent.
 *
 * **`/api/fund-task` takes no payment.** It is a *confirmation* endpoint: it reads
 * `getTask(taskId)` off the chain and only activates the row when the on-chain task is
 * `Funded` and matches on worker and amount. It was an x402 recipient until `CC-081`
 * Defect 1, and paying it deposited USDC into the escrow without calling `createTask` —
 * into a contract with no sweep and no rescue. Proving it inert is worth doing on purpose.
 *
 * ── Running ─────────────────────────────────────────────────────────────────────
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/admin/verify-funding-lifecycle.ts offer 0xWorkerAddress
 *
 * Reads from the environment:
 *   PREVIEW_BASE_URL                  where the product is deployed
 *   DEPLOYER_PRIVATE_KEY              the agent — funds from its own wallet
 *   NEXT_PUBLIC_ESCROW_CONTRACT       }  the chain half
 *   NEXT_PUBLIC_USDC_ADDRESS          }
 *   BASE_SEPOLIA_RPC_URL              optional but wanted; see CC-048
 *   VERCEL_AUTOMATION_BYPASS_SECRET   optional — see below
 *
 * **Vercel deployment protection.** A protected preview answers every request with a login
 * page, including `/api/*`, which surfaces as unparseable JSON rather than a 401. If the
 * preview is protected, generate a Protection Bypass for Automation secret and put it in
 * `.env.local` as `VERCEL_AUTOMATION_BYPASS_SECRET`; it is sent as `x-vercel-protection-bypass`
 * and never printed.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CARBON_ESCROW_ABI } from "@/lib/contracts/escrow-abi";

const STATE_FILE = resolve(process.cwd(), ".funding-lifecycle-state.json");
const line = () => "=".repeat(74);

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

interface PendingOffer {
  paymentRequestId: string;
  taskIdBytes32: Hex;
  worker: Address;
  amountWei: string;
  deadlineUnix: number;
  reviewWindowSeconds: number;
  specHash: Hex;
  escrow: Address;
  baseUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env.local`);
  return v;
}

/** Headers every request carries: the Vercel bypass, when one is configured. */
function baseHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret
    ? { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" }
    : {};
}

/**
 * A protected preview returns an HTML login page for every path, `/api/*` included. Parsing
 * that as JSON fails with something meaningless about `<`, so name the real cause here —
 * otherwise the first run of this script looks like a broken API.
 */
async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (text.includes("<html") || text.includes("Vercel")) {
      throw new Error(
        `${what} returned an HTML page rather than JSON (HTTP ${res.status}). The deployment ` +
          "is almost certainly behind Vercel protection. Set VERCEL_AUTOMATION_BYPASS_SECRET " +
          "in .env.local, or turn protection off for this preview.",
      );
    }
    throw new Error(`${what} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Wallet challenge-response, the same auth the MCP transport and every write route use. */
async function signedHeaders(baseUrl: string, account: ReturnType<typeof privateKeyToAccount>) {
  const res = await fetch(`${baseUrl}/api/basedhuman.mcp/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders() },
    body: JSON.stringify({ walletAddress: account.address }),
  });
  const body = await readJson(res, "challenge");
  const nonce = body.nonce as string | undefined;
  const message = body.message as string | undefined;
  if (!nonce || !message) {
    throw new Error(`challenge did not return a nonce and message: ${JSON.stringify(body)}`);
  }

  // Sign the message the server built. Never reconstruct it here — the two halves used to
  // be built from different clocks, which failed intermittently and looked like a wallet
  // fault (see buildChallengeMessage).
  const signature = await account.signMessage({ message });
  return {
    "x-caller-wallet": account.address,
    "x-caller-signature": signature,
    "x-caller-nonce": nonce,
  };
}

/** Extract the JSON payload an MCP tool returns as its single text content block. */
function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function runOffer(baseUrl: string, worker: Address) {
  const agent = privateKeyToAccount(required("DEPLOYER_PRIVATE_KEY") as Hex);
  const escrow = required("NEXT_PUBLIC_ESCROW_CONTRACT") as Address;

  console.log(line());
  console.log('CC-077 funding lifecycle — phase "offer"');
  console.log(line());
  console.log(`  base url:  ${baseUrl}`);
  console.log(`  agent:     ${agent.address}`);
  console.log(`  worker:    ${worker}`);
  console.log(`  bypass:    ${process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? "configured" : "none"}`);

  console.log("\n[1] wallet challenge-response as the AGENT");
  const auth = await signedHeaders(baseUrl, agent);
  console.log(`      signed nonce ${auth["x-caller-nonce"].slice(0, 12)}…`);

  console.log("\n[2] MCP initialize — the session carries the agent's verified wallet");
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/basedhuman.mcp`), {
    requestInit: { headers: { ...baseHeaders(), ...auth } },
  });
  const client = new Client({ name: "cc-077-funding-lifecycle", version: "1.0.0" });
  await client.connect(transport);
  console.log("      session established");

  // The exact bytes matter: spec_hash is keccak256 of this string, and re-serialising it
  // would change the hash the worker later acknowledges at submitWork.
  const acceptanceSpec = JSON.stringify({ schema_version: 1, criteria: { min_artefacts: 1 } });

  console.log("\n[3] request_human_work");
  const called = await client.callTool({
    name: "request_human_work",
    arguments: {
      to_human_wallet: worker,
      task_description: "CC-077 funding lifecycle verification — testnet, no real work expected.",
      amount_usdc: 1,
      deadline_hours: 24,
      review_window_hours: 12,
      acceptance_spec: acceptanceSpec,
      idempotency_key: randomBytes(16).toString("hex"),
    },
  });
  const offer = toolJson(called);
  if (offer.ok === false) throw new Error(`request_human_work refused: ${JSON.stringify(offer)}`);

  const paymentRequestId = offer.payment_request_id as string;
  const status = offer.status as string;
  console.log(`      payment_request_id: ${paymentRequestId}`);
  console.log(`      status:             ${status}`);
  console.log(`      task_id_bytes32:    ${offer.task_id_bytes32}`);
  console.log(`      spec_hash:          ${offer.spec_hash}`);

  if (status !== "pending") {
    console.log("\n" + line());
    console.log(`  WARNING — the row is "${status}", not "pending".`);
    console.log(line());
    console.log("\n  accepts_auto_booking is TRUE on one of this worker's channels, so the");
    console.log("  offer auto-accepted (ADR-0005 D3). The consent stage this phase exists to");
    console.log("  test has been skipped, and the run below would pass without proving it.");
    console.log("\n  Turn auto-booking off for this worker and start again.");
    process.exitCode = 1;
    await client.close();
    return;
  }

  console.log("\n[4] /api/fund-task must REFUSE a pending offer");
  console.log("    Money must not move before the worker has consented (ADR-0005 D2).");
  const refusal = await fetch(`${baseUrl}/api/fund-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders(), ...(await signedHeaders(baseUrl, agent)) },
    body: JSON.stringify({ payment_request_id: paymentRequestId }),
  });
  const refusalBody = await readJson(refusal, "fund-task");
  if (refusal.ok) {
    throw new Error(
      `fund-task ACCEPTED a pending offer (HTTP ${refusal.status}). That is a consent bypass, ` +
        `not a test failure: ${JSON.stringify(refusalBody)}`,
    );
  }
  console.log(`      refused with HTTP ${refusal.status} — ${refusalBody.error ?? "(no message)"}`);

  const pending: PendingOffer = {
    paymentRequestId,
    taskIdBytes32: offer.task_id_bytes32 as Hex,
    worker,
    amountWei: String(offer.amount_wei),
    deadlineUnix: Number(offer.deadline_unix),
    reviewWindowSeconds: Number(offer.review_window_seconds),
    specHash: offer.spec_hash as Hex,
    escrow,
    baseUrl,
  };
  writeFileSync(STATE_FILE, Buffer.from(JSON.stringify(pending, null, 2), "utf8"));
  await client.close();

  console.log("\n" + line());
  console.log("OFFER OPEN — waiting on the worker, which is the point.");
  console.log(line());
  console.log(`\n  State written to ${STATE_FILE}`);
  console.log(`\n  Now, as the WORKER (${worker}), in the dashboard:`);
  console.log("    connect that wallet, find the offer, and accept it.");
  console.log("\n  Then:");
  console.log("    node --env-file=.env.local node_modules/tsx/dist/cli.mjs \\");
  console.log("      scripts/admin/verify-funding-lifecycle.ts fund");
}

async function runFund() {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`No pending offer at ${STATE_FILE} — run the \`offer\` phase first.`);
  }
  const pending: PendingOffer = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const agent = privateKeyToAccount(required("DEPLOYER_PRIVATE_KEY") as Hex);
  const usdc = required("NEXT_PUBLIC_USDC_ADDRESS") as Address;
  const escrow = required("NEXT_PUBLIC_ESCROW_CONTRACT") as Address;

  if (escrow.toLowerCase() !== pending.escrow.toLowerCase()) {
    throw new Error(
      `State file is for escrow ${pending.escrow}, but NEXT_PUBLIC_ESCROW_CONTRACT is ${escrow}. ` +
        "The contract was redeployed since that offer — start over.",
    );
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || baseSepolia.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: agent, chain: baseSepolia, transport: http(rpcUrl) });
  const amount = BigInt(pending.amountWei);

  console.log(line());
  console.log('CC-077 funding lifecycle — phase "fund"');
  console.log(line());
  console.log(`  payment_request_id: ${pending.paymentRequestId}`);
  console.log(`  worker:             ${pending.worker}`);
  console.log(`  amount:             ${formatUnits(amount, 6)} USDC`);

  console.log("\n[1] USDC.approve(escrow, amount) as the AGENT");
  const approveHash = await wallet.writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [escrow, amount],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  console.log(`      tx: ${approveHash}`);

  console.log("\n[2] escrow.createTask(...) from the AGENT's own wallet");
  console.log("    The platform transacts nowhere. task.agent on-chain is msg.sender.");
  const createHash = await wallet.writeContract({
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "createTask",
    args: [
      pending.taskIdBytes32,
      pending.worker,
      amount,
      BigInt(pending.deadlineUnix),
      pending.reviewWindowSeconds,
      pending.specHash,
    ],
  });
  const createReceipt = await pub.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") throw new Error(`createTask reverted: ${createHash}`);
  console.log(`      tx: ${createHash}`);

  console.log("\n[3] POST /api/fund-task — confirmation, not payment");
  console.log("    It reads getTask() off the chain and only activates on a match.");
  const res = await fetch(`${pending.baseUrl}/api/fund-task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...baseHeaders(),
      ...(await signedHeaders(pending.baseUrl, agent)),
    },
    body: JSON.stringify({ payment_request_id: pending.paymentRequestId }),
  });
  const body = await readJson(res, "fund-task");
  console.log(`      HTTP ${res.status} — ${JSON.stringify(body).slice(0, 200)}`);

  console.log("\n" + line());
  console.log("VERIFICATION");
  console.log(line());

  const task = await pub.readContract({
    address: escrow,
    abi: CARBON_ESCROW_ABI,
    functionName: "getTask",
    args: [pending.taskIdBytes32],
  });
  const states = ["None", "Funded", "Delivered", "Completed", "Disputed", "Arbitrating", "Resolved", "Expired"];
  const onChainState = states[Number(task.state)];
  const workerMatches = String(task.worker).toLowerCase() === pending.worker.toLowerCase();
  const agentMatches = String(task.agent).toLowerCase() === agent.address.toLowerCase();

  console.log(`  on-chain state:   ${onChainState} (expected Funded)`);
  console.log(`  task.worker:      ${task.worker} ${workerMatches ? "✓" : "✗"}`);
  console.log(`  task.agent:       ${task.agent} ${agentMatches ? "✓" : "✗"}  (the funder, not the platform)`);
  console.log(`  amount:           ${formatUnits(task.amount as bigint, 6)} USDC`);
  console.log(`  row status:       ${body.status ?? "(none)"}`);

  const pass = res.ok && onChainState === "Funded" && workerMatches && agentMatches && body.status === "active";
  console.log(`\n  ${pass ? "PASS" : "FAIL"} — the row ${pass ? "is active and matches the chain" : "did not activate as expected"}.`);
  if (pass) console.log(`\n  Delete ${STATE_FILE} when you are done with it.`);
  process.exitCode = pass ? 0 : 1;
}

async function main() {
  const phase = (process.argv[2] ?? "").toLowerCase();
  if (phase !== "offer" && phase !== "fund") {
    console.error("Usage: verify-funding-lifecycle.ts <offer|fund> [workerAddress]");
    console.error("\n  offer   request_human_work, assert fund-task refuses it, then stop");
    console.error("  fund    after the worker accepts: approve + createTask + confirm");
    process.exitCode = 1;
    return;
  }

  const baseUrl = (
    process.env.PREVIEW_BASE_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    ""
  ).replace(/\/$/, "");
  if (!baseUrl) throw new Error("PREVIEW_BASE_URL must be set — where the product is deployed");

  if (phase === "fund") return runFund();

  const worker = (process.argv[3] ?? process.env.WORKER_WALLET ?? "") as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(worker)) {
    throw new Error("Pass the worker address as the second argument, or set WORKER_WALLET");
  }
  if (worker.toLowerCase() === privateKeyToAccount(required("DEPLOYER_PRIVATE_KEY") as Hex).address.toLowerCase()) {
    // Nothing in the contract or the app forbids this, which is exactly why it is checked
    // here: every role-separation property this stage tests collapses, and every assertion
    // still passes.
    throw new Error(
      "The worker and the agent are the same address. Nothing rejects that on-chain, and " +
        "that is the problem — `callerIsWorker` and `callerIsAgent` would both be true, and " +
        "agent-only and worker-only calls would both succeed from one key. Use a second wallet.",
    );
  }
  return runOffer(baseUrl, worker);
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
