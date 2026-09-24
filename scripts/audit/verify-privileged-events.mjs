/**
 * verify-privileged-events.mjs — READ-ONLY. CC-040, ADR-0003 handover step 6.
 *
 * Invariant: every privileged event the escrow has ever emitted — OwnershipTransferred,
 * VerdictSignerUpdated — matches the committed allowlist. Both events change who can
 * move or authorise money, and both are exactly the ADR-0003 silent class when they
 * happen unobserved: the contract keeps working, every state read stays consistent,
 * and the only trace is an event nobody was watching. OwnershipTransferred to an
 * unexpected address IS the owner-compromise case; VerdictSignerUpdated(0x…, false) on
 * the production signer means every verdict silently stops being accepted.
 *
 * Statelessness, per ADR-0003 D5: no indexer, no database, no cursor carried between
 * runs. Each run replays the full event history from ESCROW_DEPLOY_BLOCK and compares
 * against the allowlist below — a missed run costs nothing and there is no store to
 * corrupt. The current volume (3 events) makes the full replay a two-RPC operation.
 *
 * The allowlist is committed to the repo ON PURPOSE (same reasoning as monitors.yml's
 * inline addresses): an operator rotating the signer or transferring ownership is a
 * deliberate act that lands a PR updating this file — the same review gate as any
 * other change to who can move money. An operator who cannot land a PR can still
 * rotate safely out-of-band and add the entry afterwards; the monitor then goes green
 * on the next run without ever having paged anyone about the authorised change.
 *
 *   node --env-file=.env.local scripts/audit/verify-privileged-events.mjs
 *   node --env-file=.env.local scripts/audit/verify-privileged-events.mjs --allowlist=<path>
 *
 * Exit codes: 0 clean · 1 violation (an event outside the allowlist) · 2 misconfigured ·
 *             3 transient RPC failure
 */

import { createPublicClient, http, parseAbiItem } from "viem";
import { base, baseSepolia } from "viem/chains";
import { readFileSync, existsSync } from "node:fs";
import { withRpcRetry, isTransient } from "./rpc-retry.mjs";
import { DEFAULT_ALLOWLIST, isAuthorised } from "./privileged-allowlist.mjs";

const events = {
  OwnershipTransferred: parseAbiItem(
    "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  ),
  VerdictSignerUpdated: parseAbiItem(
    "event VerdictSignerUpdated(address indexed signer, bool accepted)",
  ),
};

// The allowlist and matcher live in privileged-allowlist.mjs (testable; see the note
// there about the field-name bug the first inline draft shipped).

// ── Argument parsing ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const allowlistArg = argv.find((a) => a.startsWith("--allowlist="))?.slice("--allowlist=".length);
const drillArg = argv.find((a) => a.startsWith("--drill-entry="))?.slice("--drill-entry=".length);

let allowlist = DEFAULT_ALLOWLIST;
if (allowlistArg) {
  if (!existsSync(allowlistArg)) {
    console.log(`MISCONFIGURED — allowlist file not found: ${allowlistArg}`);
    process.exit(2);
  }
  try {
    allowlist = JSON.parse(readFileSync(allowlistArg, "utf8"));
  } catch (err) {
    console.log(`MISCONFIGURED — allowlist is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const mainnet = process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet";
const chain = mainnet ? base : baseSepolia;
const rpcUrl =
  (mainnet ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) ||
  chain.rpcUrls.default.http[0];
const escrow = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
const deployBlock = process.env.ESCROW_DEPLOY_BLOCK;

console.log("── Privileged event monitor (CC-040) ─────────────────────");
console.log(`escrow  ${escrow ?? "(unset)"}`);
console.log(`from    block ${deployBlock ?? "(unset)"}`);
console.log("");

if (!escrow || !deployBlock) {
  console.log("MISCONFIGURED — NEXT_PUBLIC_ESCROW_CONTRACT and ESCROW_DEPLOY_BLOCK must be set.");
  console.log("Without a start block the replay would scan from genesis (CC-070).");
  process.exit(2);
}

const client = createPublicClient({ chain, transport: http(rpcUrl) });

// Chunked getLogs, per CC-048/CC-070: the public endpoint rejects any range over
// ~10k blocks, and the deploy-to-head span is ~640k. Chunk size mirrors the
// workflow's RPC_MAX_BLOCK_RANGE. A range error is NOT transient — retrying the
// same oversize range can never succeed — so chunking is the only correct shape.
const CHUNK = BigInt(Number(process.env.RPC_MAX_BLOCK_RANGE ?? 10_000));

async function getLogsChunked(event) {
  const fromBlock = BigInt(deployBlock);
  const head = await withRpcRetry("blockNumber", () => client.getBlockNumber());
  const out = [];
  for (let f = fromBlock; f <= head; f += CHUNK + 1n) {
    const t = f + CHUNK > head ? head : f + CHUNK;
    const logs = await withRpcRetry(`getLogs block ${f}`, () =>
      client.getLogs({ address: escrow, event, fromBlock: f, toBlock: t }),
    );
    out.push(...logs);
  }
  return { head, logs: out };
}

function classify(e) {
  return isAuthorised(e, allowlist);
}

function fmt(e) {
  if (e.kind === "OwnershipTransferred") {
    return `${short(e.args.previousOwner)} → ${short(e.args.newOwner)}`;
  }
  return `${short(e.args.signer)} accepted=${e.args.accepted}`;
}

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : "0x0");

async function main() {
try {
  const head = await withRpcRetry("blockNumber", () => client.getBlockNumber());
  const found = [];
  for (const [kind, abi] of Object.entries(events)) {
    const logs = await getLogsChunked(abi);
    found.push(
      ...logs.logs.map((l) => ({
        kind,
        tx: l.transactionHash,
        block: Number(l.blockNumber),
        args: l.args,
      })),
    );
  }

  if (drillArg) {
    // Drill mode: inject a fake event that matches nothing, to exercise the violation
    // path on demand without needing a real compromise to occur. Same philosophy as
    // run-monitors' --args drills — an alerting path nobody has watched fire is not
    // one you can rely on.
    found.push({
      kind: "OwnershipTransferred",
      tx: `0x${"0".repeat(64)}`,
      block: Number(head),
      args: { previousOwner: "0xdead", newOwner: "0xbeef" },
    });
    console.log(`DRILL — an unmatched synthetic event was injected (${drillArg || "default"}).`);
    console.log("");
  }

  console.log(`history: ${found.length} privileged event(s) since block ${deployBlock}.`);
  for (const e of found) {
    const ok = classify(e);
    console.log(`  ${ok ? "  ok  " : "BREACH"}  ${e.kind}  block ${e.block}  ${fmt(e)}  tx ${e.tx.slice(0, 10)}…`);
  }
  console.log("");

  const violations = found.filter((e) => !classify(e));
  if (violations.length === 0) {
    console.log("CLEAN — every privileged event in the escrow's history matches the allowlist.");
    return 0;
  }

  console.log(`VIOLATION — ${violations.length} privileged event(s) outside the allowlist:`);
  for (const v of violations) {
    console.log(`  · ${v.kind} at block ${v.block} — ${fmt(v)} — tx ${v.tx}`);
  }
  console.log("");
  console.log("This is the owner-key-has-moved case. A privileged event the repo did not");
  console.log("authorise has been emitted. Treat as ownership compromise until verified");
  console.log("otherwise (runbook: docs/runbooks/INVARIANT-ALERTS.md §Owner). Do NOT pause");
  console.log("claims. Check whether the new owner/signer address is one you recognise,");
  console.log("then either add the event to the allowlist via PR if it was authorised, or");
  console.log("follow Key-Compromise-Recovery.md if it was not.");
  return 1;
} catch (err) {
  if (isTransient(err)) {
    console.log(`TRANSIENT — RPC unreachable after retries: ${err instanceof Error ? err.name : String(err)}`);
    return 3;
  }
  console.log(`MISCONFIGURED — ${err instanceof Error ? err.message : String(err)}`);
  return 2;
}
}

process.exitCode = await main();
