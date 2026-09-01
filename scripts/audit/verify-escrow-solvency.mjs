/**
 * verify-escrow-solvency.mjs — READ-ONLY. CC-037 item 1.
 *
 * Answers: is there USDC sitting in CarbonEscrow that no task can ever release?
 *
 * The invariant:
 *
 *     USDC.balanceOf(escrow)  ==  escrow.totalLocked()
 *
 * `totalLocked` is only ever incremented by createTask(), and only ever decremented when
 * funds leave via completeTask/resolveDispute/expireTask. So it is the contract's own
 * record of how much of its balance is accounted for by a real task. Any excess arrived
 * as a bare ERC-20 transfer without createTask() being called — and CarbonEscrow has no
 * sweep, rescue, or owner-withdraw function, and no receive/fallback. Excess is therefore
 * PERMANENTLY UNRECOVERABLE by anyone, including the owner.
 *
 * Why this is not hypothetical: /api/fund-task is wrapped in
 * withX402(handler, getPlatformWallet(), ...) and getPlatformWallet() returns
 * NEXT_PUBLIC_ESCROW_CONTRACT. An x402 settlement is a plain USDC transfer to that
 * address, so the documented funding path deposits into the contract WITHOUT creating a
 * task. See CC-037.
 *
 * A deficit (totalLocked > balance) would be worse: the contract believes it holds more
 * than it does, so some later release will revert on transfer.
 *
 * Executes no writes and sends no transactions. Prints only public addresses — never key
 * material, never the Supabase project ref.
 *
 *   node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs
 *
 * Exit codes: 0 clean · 1 stranded or deficit · 2 misconfigured · 3 transient RPC failure
 *
 * Note: this sets `process.exitCode` and returns rather than calling process.exit().
 * On Windows, process.exit() while an HTTP keep-alive socket is still open trips a libuv
 * assertion (`!(handle->flags & UV_HANDLE_CLOSING)`) and reports a bogus exit 127 even on
 * the success path, which makes the script useless to CI or to a scripted check.
 */

import { createPublicClient, http, getAddress, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import { withRpcRetry, isTransient, shortError, chainIdMismatch } from "./rpc-retry.mjs";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const ESCROW_ABI = [
  {
    type: "function",
    name: "totalLocked",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

const usdcFmt = (v) => `${formatUnits(v, 6)} USDC`;

async function main() {
  const escrowRaw = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  const usdcRaw = process.env.NEXT_PUBLIC_USDC_ADDRESS;
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK || "testnet";
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;

  if (!escrowRaw || !usdcRaw) {
    console.error(
      "MISCONFIGURED: NEXT_PUBLIC_ESCROW_CONTRACT and NEXT_PUBLIC_USDC_ADDRESS are both required.",
    );
    return 2;
  }

  const escrow = getAddress(escrowRaw);
  const usdc = getAddress(usdcRaw);
  const chain = network === "mainnet" ? base : baseSepolia;

  const client = createPublicClient({ chain, transport: http(rpcUrl || undefined) });

  // Before any contract read: is this endpoint even on the right chain? An RPC pointed at
  // the wrong network answers every call cheerfully, about a different chain, so a
  // perfectly healthy contract reads back as `0x`.
  const mismatch = await chainIdMismatch(client, chain.id, "BASE_SEPOLIA_RPC_URL");
  if (mismatch) {
    console.error(mismatch);
    return 2;
  }

  console.log("── CarbonEscrow solvency ────────────────────────────────────────");
  console.log(`network   ${network} (chain ${chain.id})`);
  console.log(`escrow    ${escrow}`);
  console.log(`usdc      ${usdc}`);
  console.log(
    `rpc       ${rpcUrl ? "dedicated endpoint (BASE_SEPOLIA_RPC_URL set)" : "PUBLIC FALLBACK — rate limited, see CC-048"}`,
  );
  console.log("");

  let balance, totalLocked, owner;
  try {
    [balance, totalLocked, owner] = await withRpcRetry("solvency reads", () =>
      Promise.all([
        client.readContract({
          address: usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [escrow],
        }),
        client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "totalLocked" }),
        client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "owner" }),
      ]),
    );
  } catch (err) {
    if (isTransient(err)) {
      console.error(`TRANSIENT — RPC unreachable after retries: ${shortError(err)}`);
      return 3;
    }
    console.error(`MISCONFIGURED: RPC read failed: ${shortError(err)}`);
    // `returned no data ("0x")` is NOT a rate-limit symptom, and calling it one sends the
    // reader somewhere useless. It means the call reached a node that has no contract at
    // this address — wrong address, or an endpoint on a different chain. This text used to
    // advise setting BASE_SEPOLIA_RPC_URL even when the line above had just reported it as
    // set, which is how it read on 2026-09-01.
    if (/returned no data/i.test(String(err?.shortMessage ?? err?.message ?? err))) {
      console.error("");
      console.error('"returned no data" means there is no contract at that address on the');
      console.error("chain this endpoint talks to. Two causes, and neither is rate limiting:");
      console.error("  1. NEXT_PUBLIC_ESCROW_CONTRACT points somewhere with no code, or");
      console.error("  2. the RPC endpoint is on a different network than expected.");
      console.error("The chain-id check above rules out (2), so suspect (1) if it passed.");
    } else if (!process.env.BASE_SEPOLIA_RPC_URL) {
      console.error("If this is a rate-limit error, set BASE_SEPOLIA_RPC_URL — see CC-048.");
    }
    return 2;
  }

  console.log(`USDC balanceOf(escrow)   ${usdcFmt(balance).padStart(20)}   (${balance} units)`);
  console.log(`escrow.totalLocked()     ${usdcFmt(totalLocked).padStart(20)}   (${totalLocked} units)`);
  console.log(`escrow.owner()           ${owner}`);
  console.log("");

  const delta = balance - totalLocked;

  if (delta === 0n) {
    console.log("CLEAN — balance equals totalLocked.");
    console.log("Every USDC held by the contract is accounted for by a createTask() call.");
    console.log("No bare transfer has landed here, or any that did has been exactly offset.");
    return 0;
  }

  if (delta > 0n) {
    console.log(`STRANDED — ${usdcFmt(delta)} is held by the contract but belongs to no task.`);
    console.log("");
    console.log("This USDC arrived without createTask() being called, so no task struct");
    console.log("references it and no code path can move it. CarbonEscrow exposes no sweep,");
    console.log("rescue, or owner-withdraw function and has no receive/fallback. It is");
    console.log("unrecoverable by anyone, including the contract owner.");
    console.log("");
    console.log("Most likely source: /api/fund-task's x402 settlement, which pays");
    console.log("NEXT_PUBLIC_ESCROW_CONTRACT directly as a plain ERC-20 transfer. See CC-037.");
    return 1;
  }

  console.log(`DEFICIT — totalLocked exceeds the actual balance by ${usdcFmt(-delta)}.`);
  console.log("");
  console.log("The contract believes it holds more USDC than it does, so at least one future");
  console.log("completeTask/resolveDispute/expireTask will revert when it attempts safeTransfer.");
  console.log("This is more serious than stranded funds: an accounting path is wrong, not");
  console.log("merely a deposit bypassing accounting. Investigate before any further funding.");
  return 1;
}

process.exitCode = await main();
