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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, getAddress, toFunctionSelector, keccak256 } from "viem";
import { baseSepolia, base } from "viem/chains";

/** CC-059 — the HSM key that must own the contract and whose verdicts it must accept. */
const HSM = "0xa8931097540e69B474013D294d0bA6A2cC853e4b";

/**
 * CC-090 — the address the contract is expected to accept verdicts from.
 *
 * NOT necessarily the owner. The whole point of CC-090 is that verdict signing and
 * contract ownership are two roles that will move to different custodies (owner to a
 * 2-of-4 Safe, signer staying a hot KMS key), and this script previously checked
 * acceptedSigners() against the HSM owner constant — the exact conflation the ticket
 * exists to remove. Once separation lands, that check would fail against a perfectly
 * correct deployment, and worse, it could never *detect* a separation regression
 * (signer == owner re-merged) because it asserted they were the same address.
 *
 * Resolution order:
 *   1. --signer=0xADDR  — explicit override for key-rotation windows: you want to know
 *      setVerdictSigner(new, true) landed BEFORE signing switches to it, and that the
 *      old one was removed after (same pattern as verify-signer.mjs).
 *   2. VERDICT_SIGNER_ADDRESS — what the deploy script seeds the accepted-signer set
 *      from, and what the signing path actually signs with.
 *   3. The committed .pub — what the signing key derives to today, offline.
 *
 * The first two are environment; the third is the repo's independent statement of
 * intent. If they disagree, verify-signer.mjs flags it — this script reports the
 * mismatch rather than silently picking a winner.
 */

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

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB_KEY = join(REPO, "docs", "carbon-contractors-escrow-signer-1.pub");

/**
 * Derive an Ethereum address from a secp256k1 SubjectPublicKeyInfo PEM, offline.
 * Mirrors addressFromPem() in verify-contract-owner.mjs and verify-signer.mjs, which
 * in turn mirror getEthAddressFromKms() in src/lib/contracts/kms-signer.ts — the
 * uncompressed EC point (0x04 || x || y) is always the last 65 bytes of the DER.
 */
function addressFromPem(path) {
  const body = readFileSync(path, "utf8")
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error(
      `Expected uncompressed EC point (0x04 prefix), got 0x${point[0].toString(16)}`,
    );
  }
  return getAddress("0x" + keccak256("0x" + Buffer.from(point.subarray(1)).toString("hex")).slice(-40));
}

const mark = (ok) => (ok ? "✓" : "✗");

async function main() {
  const args = process.argv.filter((a) => !a.startsWith("--signer="));
  const signerOverrideRaw = process.argv
    .find((a) => a.startsWith("--signer="))
    ?.slice("--signer=".length);
  const override = args[2];
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

  // ── Expected verdict signer (CC-090) ───────────────────────────────────────
  let pubKeyAddress = null;
  try {
    pubKeyAddress = addressFromPem(PUB_KEY);
  } catch (err) {
    if (!signerOverrideRaw) {
      console.error(`MISCONFIGURED: could not derive the HSM address from ${PUB_KEY}`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    // Under an explicit --signer override the PEM is not needed to name the
    // expected signer; it is still printed as a cross-check when available.
  }
  let expectedSigner;
  try {
    expectedSigner = signerOverrideRaw ? getAddress(signerOverrideRaw) : pubKeyAddress;
  } catch (err) {
    console.error(`MISCONFIGURED: --signer=${signerOverrideRaw} is not a valid address.`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const envSigner = process.env.VERDICT_SIGNER_ADDRESS;
  const envSignerAgrees =
    !envSigner || getAddress(envSigner) === expectedSigner;

  console.log(`expected signer           ${expectedSigner}  (${signerOverrideRaw ? "--signer override" : "committed .pub"})`);
  if (signerOverrideRaw && pubKeyAddress) {
    console.log(`  cross-check committed .pub       ${pubKeyAddress}  ${pubKeyAddress === expectedSigner ? "matches" : "DIFFERS"}`);
  }
  if (envSigner) {
    console.log(`  cross-check VERDICT_SIGNER_ADDRESS  ${getAddress(envSigner)}  ${envSignerAgrees ? "matches" : "DIFFERS"}`);
  }
  console.log();

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
      call("acceptedSigners", [expectedSigner]),
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
  console.log(
    `acceptedSigners(signer)  ${mark(signerAccepted)}  ${signerAccepted}  (${signerOverrideRaw ? "from --signer" : "from committed .pub"})`,
  );
  const signerIsOwner = owner.toLowerCase() === expectedSigner.toLowerCase();
  console.log(
    `signer/owner separation  ${signerIsOwner ? "SAME key (CC-090 open — testnet posture)" : "separated (CC-090)"}`,
  );
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
