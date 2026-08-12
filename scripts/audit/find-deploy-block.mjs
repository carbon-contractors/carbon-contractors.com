/**
 * find-deploy-block.mjs — READ-ONLY. CC-070.
 *
 * Finds the block a contract was deployed at, by binary search on eth_getCode.
 *
 * Why this exists: every getLogs query in src/lib/contracts/escrow.ts defaulted
 * fromBlock to 0. Chunking those queries is only half the fix — Base Sepolia is
 * tens of millions of blocks deep, so scanning from genesis in 2000-block windows
 * would be tens of thousands of RPC calls per request. The queries need a real
 * lower bound, and the deployment block is it.
 *
 * eth_getCode at a historical block returns "0x" before deployment and the runtime
 * bytecode after, so the transition is a step function and binary search finds it in
 * ~log2(head) calls — about 26 for a 45M-block chain, versus 22,000+ for a genesis scan.
 *
 * Run this once per deployment and put the answer in ESCROW_DEPLOY_BLOCK. It will need
 * re-running for the mainnet deploy (CC-034).
 *
 *   node --env-file=.env.local scripts/audit/find-deploy-block.mjs
 *   node --env-file=.env.local scripts/audit/find-deploy-block.mjs 0xSomeOtherContract
 *
 * Executes no writes and sends no transactions.
 */

import { createPublicClient, http, getAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

async function main() {
  const target = process.argv[2] ?? process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK ?? "testnet";
  const rpcUrl =
    network === "mainnet"
      ? process.env.BASE_MAINNET_RPC_URL
      : process.env.BASE_SEPOLIA_RPC_URL;

  if (!target) {
    console.error(
      "MISCONFIGURED: pass an address, or set NEXT_PUBLIC_ESCROW_CONTRACT.",
    );
    return 2;
  }

  const address = getAddress(target);
  const chain = network === "mainnet" ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl || undefined) });

  console.log(`network   ${network} (chain ${chain.id})`);
  console.log(`address   ${address}`);
  console.log(
    `rpc       ${rpcUrl ? "dedicated endpoint" : "PUBLIC FALLBACK — rate limited, see CC-048"}`,
  );
  console.log("");

  const head = await client.getBlockNumber();

  const codeNow = await client.getCode({ address });
  if (!codeNow || codeNow === "0x") {
    console.error(`No contract code at ${address} as of head block ${head}.`);
    console.error("Wrong address, wrong network, or not deployed.");
    return 2;
  }

  // Invariant: code absent at `lo`, present at `hi`. Narrow until adjacent.
  let lo = 0n;
  let hi = head;
  let calls = 1;

  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    let code;
    try {
      code = await client.getCode({ address, blockNumber: mid });
      calls++;
    } catch (err) {
      console.error(`getCode failed at block ${mid}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(
        "Public RPC nodes often prune historical state. A archive-capable endpoint is needed",
      );
      console.error("for this search — see CC-048. Falling back: check Basescan for the deploy tx.");
      return 2;
    }
    if (!code || code === "0x") lo = mid;
    else hi = mid;
  }

  const deployBlock = hi;
  const blocksSince = head - deployBlock;
  const CHUNK = 2000n;

  console.log(`head block        ${head}`);
  console.log(`deploy block      ${deployBlock}`);
  console.log(`blocks since      ${blocksSince}`);
  console.log(`getCode calls      ${calls}`);
  console.log("");
  console.log("── what this means for chunked getLogs (2000-block windows) ──");
  console.log(`from deploy block  ${(blocksSince + CHUNK - 1n) / CHUNK} request(s) per query`);
  console.log(`from genesis       ${(head + CHUNK - 1n) / CHUNK} request(s) per query`);
  console.log("");
  console.log("Set this in .env.local and in the Vercel Production environment:");
  console.log("");
  console.log(`  ESCROW_DEPLOY_BLOCK=${deployBlock}`);
  console.log("");
  console.log("Re-run after the mainnet deploy (CC-034) and update the value.");

  return 0;
}

process.exitCode = await main();
