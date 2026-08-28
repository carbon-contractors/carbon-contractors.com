/**
 * verify-escrow-deployment.mjs — READ-ONLY. CC-082.
 *
 * Answers: is the deployed CarbonEscrow actually v2, and is it configured correctly?
 *
 * Why this exists as an audit script rather than a line in the deploy script: the deploy
 * script's own post-deploy read failed on the real Sepolia deploy (2026-08-15) with
 * `could not decode result data (value="0x")`. Not a bad deployment — the public
 * sepolia.base.org gateway has no read-your-writes guarantee across its load-balanced
 * backends, so the node serving `owner()` had not yet seen the block carrying the
 * contract's code. The deploy had in fact succeeded.
 *
 * A verification that can fail for reasons unrelated to what it verifies is worse than no
 * verification, because the next reader cannot tell the two apart. So this is separate,
 * re-runnable, and retries the reads.
 *
 * Usage:
 *   node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs
 *   node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs 0xADDRESS
 *
 * The positional argument exists so a fresh deployment can be checked BEFORE
 * NEXT_PUBLIC_ESCROW_CONTRACT is re-pointed at it — which is the order the CC-082
 * checklist actually happens in.
 */

import { createPublicClient, http, getAddress, toFunctionSelector } from "viem";
import { baseSepolia, base } from "viem/chains";

/** CC-059 — the HSM key that must own the contract and whose verdicts it must accept. */
const HSM = "0xa8931097540e69B474013D294d0bA6A2cC853e4b";

const ABI = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "usdc", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "totalLocked", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "MIN_REVIEW_WINDOW", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "MAX_REVIEW_WINDOW", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "ARBITRATION_WINDOW", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "domainSeparator", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "VERDICT_TYPEHASH", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  {
    type: "function",
    name: "acceptedSigners",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
];

/** Retries the read-your-writes lag described in the header. */
async function withRetry(label, fn, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      process.stdout.write(`   ${label}: RPC not caught up, retrying (${i}/${attempts - 1})...\n`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const mark = (ok) => (ok ? "✓" : "✗");

async function main() {
  const override = process.argv[2];
  const raw = override ?? process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  if (!raw) {
    console.error("Pass an address, or set NEXT_PUBLIC_ESCROW_CONTRACT.");
    process.exit(1);
  }

  const escrow = getAddress(raw);
  const mainnet = process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet";
  const chain = mainnet ? base : baseSepolia;
  const rpcUrl =
    (mainnet ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) ??
    chain.rpcUrls.default.http[0];

  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  console.log("── CarbonEscrow v2 deployment ───────────────────────────────────");
  console.log(`network   ${chain.name} (${chain.id})`);
  console.log(`escrow    ${escrow}`);
  if (override) console.log("          (from argv — NOT from NEXT_PUBLIC_ESCROW_CONTRACT)");
  console.log();

  const code = await withRetry("getCode", async () => {
    const c = await client.getCode({ address: escrow });
    if (!c || c === "0x") throw new Error("no bytecode");
    return c;
  });
  console.log(`bytecode present         ${mark(true)}  ${(code.length - 2) / 2} bytes`);

  const call = (functionName, args = []) =>
    withRetry(functionName, () => client.readContract({ address: escrow, abi: ABI, functionName, args }));

  // v2 surface. A v1 contract has none of these, so a failure here is the check working.
  let min, max, domain, typehash, signerAccepted;
  try {
    [min, max, domain, typehash, signerAccepted] = await Promise.all([
      call("MIN_REVIEW_WINDOW"),
      call("MAX_REVIEW_WINDOW"),
      call("domainSeparator"),
      call("VERDICT_TYPEHASH"),
      call("acceptedSigners", [getAddress(HSM)]),
    ]);
  } catch {
    console.log(`\n${mark(false)} This is NOT CarbonEscrow v2 — the v2 functions are absent.`);
    console.log("  Either the address points at the old deployment, or the redeploy did not run.");
    process.exit(1);
  }

  const [owner, usdc, locked] = await Promise.all([call("owner"), call("usdc"), call("totalLocked")]);

  // ── The ADR-0006 D3 arbitration clock ─────────────────────────────────────
  //
  // Probed separately from the v2 surface above, and NOT fatal by default, because its
  // absence is a legitimate state: every escrow deployed before 2026-08-28 lacks it, and
  // the app is built to read those (see LEGACY_GET_TASK_ABI). What is not legitimate is
  // shipping mainnet without it — ADR-0006 makes it bytecode-or-never, and a mainnet v1
  // with no arbitration clock has disputes that can strand permanently. So: informational
  // on testnet, fatal on mainnet.
  let arbitrationWindow = null;
  try {
    arbitrationWindow = Number(await call("ARBITRATION_WINDOW"));
  } catch {
    arbitrationWindow = null;
  }

  // Corroborating signal only. Solidity embeds each external function's 4-byte selector
  // in its dispatcher, so the selector appearing in the code is good evidence the
  // function is there — but 4 bytes in ~10KB can collide, which is why ARBITRATION_WINDOW
  // above is the primary check and this is a cross-check on it.
  const RELEASE_AFTER_ARBITRATION_SELECTOR = toFunctionSelector(
    "releaseAfterArbitration(bytes32)",
  ).slice(2);
  const claimPathPresent = code.toLowerCase().includes(RELEASE_AFTER_ARBITRATION_SELECTOR);

  const expectedUsdc = process.env.NEXT_PUBLIC_USDC_ADDRESS;
  const ownerIsHsm = owner.toLowerCase() === HSM.toLowerCase();
  const usdcOk = !expectedUsdc || usdc.toLowerCase() === expectedUsdc.toLowerCase();

  console.log(`is v2 (verdict surface)  ${mark(true)}`);
  console.log(`MIN_REVIEW_WINDOW        ${mark(min === 43200)}  ${min}s (${min / 3600}h)`);
  console.log(`MAX_REVIEW_WINDOW        ${mark(max === 1209600)}  ${max}s (${max / 86400}d)`);
  if (arbitrationWindow === null) {
    console.log(
      `ARBITRATION_WINDOW       ${mark(false)}  ABSENT — this deployment predates ADR-0006 D3`,
    );
  } else {
    console.log(
      `ARBITRATION_WINDOW       ${mark(arbitrationWindow === 604800)}  ${arbitrationWindow}s (${arbitrationWindow / 86400}d)`,
    );
  }
  console.log(
    `releaseAfterArbitration  ${mark(claimPathPresent)}  ${claimPathPresent ? "selector present in bytecode" : "selector ABSENT"}`,
  );
  console.log(`usdc()                   ${mark(usdcOk)}  ${usdc}`);
  // Informational, not a pass/fail. This started life marking non-zero with ✗, which was
  // right for a fresh deployment and wrong the moment a task was funded — it flagged a
  // perfectly normal escrow while still printing CLEAN underneath. Whether the balance is
  // *accounted for* is verify-escrow-solvency.mjs's question, not this script's.
  console.log(`totalLocked()               ${locked} units${locked === 0n ? " (nothing in flight)" : ""}`);
  console.log(`owner()                  ${mark(ownerIsHsm)}  ${owner}`);
  console.log(`acceptedSigners(HSM)     ${mark(signerAccepted)}  ${signerAccepted}`);
  console.log(`VERDICT_TYPEHASH         ${typehash}`);
  console.log(`domainSeparator()        ${domain}`);

  // ── What the arbitration clock's absence means, per network ───────────────
  if (arbitrationWindow === null || !claimPathPresent) {
    console.log("");
    console.log("The arbitration clock (ADR-0006 D3) is NOT in this deployment.");
    console.log("On-chain consequence: a Disputed task has no deadline. Only the owner can");
    console.log("end it, and if the owner never acts the escrow is held indefinitely — which");
    console.log("is the stranding case ADR-0006 exists to close.");
    console.log("");
    if (mainnet) {
      console.log("This is MAINNET, so it is fatal. ADR-0006 makes the clock bytecode-or-never:");
      console.log("the only way to add it later is a second mainnet deploy with a migration.");
      console.log("Redeploy from a build that includes it before anything is funded.");
      process.exit(1);
    }
    console.log("This is testnet, so it is reported and not fatal — the app reads a pre-clock");
    console.log("deployment deliberately (escrow.ts LEGACY_GET_TASK_ABI). But the Sepolia");
    console.log("dispute lifecycle CANNOT be exercised against this contract: there is no");
    console.log("timeout to test. Redeploy before running the dispute stage.");
    console.log("");
  } else if (arbitrationWindow !== 604800) {
    console.log("");
    console.log(`ARBITRATION_WINDOW is ${arbitrationWindow}s, not the 604800s (7 days) ADR-0006 A1.3`);
    console.log("sets. It is a contract constant, so this cannot be corrected without a");
    console.log("redeploy. chain-constants.json records 604800; one of the two is wrong.");
    process.exit(1);
  }

  // Binary search for the deploy block, so ESCROW_DEPLOY_BLOCK never has to be guessed.
  let lo = 0n;
  let hi = await client.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const c = await client.getCode({ address: escrow, blockNumber: mid });
    lo = c && c !== "0x" ? lo : mid + 1n;
    hi = c && c !== "0x" ? mid : hi;
  }
  console.log(`\nESCROW_DEPLOY_BLOCK=${lo}`);

  console.log();
  if (!ownerIsHsm) {
    console.log(`✗ OWNER IS NOT THE HSM KEY. Run \`npm run transfer:ownership\` (CC-059).`);
    console.log(`  expected ${HSM}`);
    process.exit(1);
  }
  if (!signerAccepted) {
    console.log("✗ The HSM key is not an accepted verdict signer — settlement cannot verify a");
    console.log("  verdict. Owner must call setVerdictSigner(HSM, true).");
    process.exit(1);
  }
  if (!usdcOk) {
    console.log(`✗ usdc() does not match NEXT_PUBLIC_USDC_ADDRESS (${expectedUsdc}).`);
    process.exit(1);
  }
  console.log("✓ CLEAN — v2, owned by the HSM key, verdict signer seeded.");
  console.log("  Whether the locked balance is accounted for is a separate question:");
  console.log("    node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs");
}

main().catch((err) => {
  console.error("\nFATAL:", err.shortMessage ?? err.message ?? err);
  process.exit(1);
});
