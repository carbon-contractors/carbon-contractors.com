/**
 * admin/transfer-escrow-ownership.ts
 *
 * CC-059 — transfers ownership of CarbonEscrow and ReputationStake from the
 * raw local deployer key to the GCP KMS/HSM-derived signing address.
 *
 * This is a ONE-WAY, IRREVERSIBLE on-chain action: once the HSM address owns
 * these contracts, the local DEPLOYER_PRIVATE_KEY can no longer arbitrate
 * disputes. Do not run this with CONFIRM=true until `npm run verify:kms` (or
 * an equivalent check against a live Vercel deployment) has confirmed the KMS
 * key can actually produce valid signatures — see CC-059's "Fix" section.
 *
 * Usage:
 *   npx hardhat run scripts/admin/transfer-escrow-ownership.ts --network baseSepolia
 *     -> dry run: reads current owners, derives the HSM address, prints what
 *        WOULD happen. Sends no transactions.
 *
 *   CONFIRM=true npx hardhat run scripts/admin/transfer-escrow-ownership.ts --network baseSepolia
 *     -> actually calls transferOwnership() on both contracts.
 *
 * (Hardhat 3's `run` task validates CLI arguments strictly against its own
 * defined parameters and rejects anything else — the Hardhat 2-era
 * `-- --flag` passthrough to the script's own argv no longer works, hence the
 * env var instead.)
 *
 * Requires in .env.local:
 *   DEPLOYER_PRIVATE_KEY=0x...        (must be the CURRENT owner of both contracts)
 *   NEXT_PUBLIC_ESCROW_CONTRACT=0x...
 *   NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT=0x...
 */

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The subset of the HRE-injected ethers namespace this script needs. */
interface EthersLike {
  keccak256(data: string): string;
  getAddress(address: string): string;
  getSigners(): Promise<Array<{ address: string }>>;
  // ethers hands back an untyped `Contract` — hardhat-typechain is configured but emits
  // nothing under Hardhat 3, so contract methods resolve at runtime through its proxy.
  // This used to declare `{ owner(); transferOwnership() }`, which read as safer but was
  // never actually checked: the file was excluded from every tsconfig until CC-082 added
  // one that covers it, and the declaration does not match what ethers returns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContractAt(name: string, address: string): Promise<any>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUB_KEY_PATH = join(__dirname, "..", "..", "docs", "carbon-contractors-escrow-signer-1.pub");

/**
 * Derive an Ethereum address from a secp256k1 SubjectPublicKeyInfo PEM.
 * The uncompressed EC point (0x04 || x || y) is always the last 65 bytes of
 * the DER. Mirrors scripts/audit/verify-contract-owner.mjs and
 * getEthAddressFromKms() in src/lib/contracts/kms-signer.ts — kept as a
 * derivation, not a hardcoded literal, so a typo can't silently send
 * ownership somewhere wrong.
 */
function addressFromPem(path: string, ethers: EthersLike): string {
  const body = readFileSync(path, "utf8")
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error(`Expected uncompressed EC point (0x04 prefix), got 0x${point[0].toString(16)}`);
  }
  const hash = ethers.keccak256("0x" + Buffer.from(point.subarray(1)).toString("hex"));
  return ethers.getAddress("0x" + hash.slice(-40));
}

const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
const STAKE_ADDRESS = process.env.NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT;

if (!ESCROW_ADDRESS) throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT must be set in .env.local");
if (!STAKE_ADDRESS) throw new Error("NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT must be set in .env.local");

const CONFIRM = process.env.CONFIRM === "true";

interface TransferResult {
  name: string;
  ok: boolean;
  skipped: boolean;
  dryRun: boolean;
}

async function transferOne(
  ethers: EthersLike,
  contractName: "CarbonEscrow" | "ReputationStake",
  address: string,
  newOwner: string,
  deployerAddress: string,
): Promise<TransferResult> {
  console.log(`\n── ${contractName} @ ${address}`);
  const contract = await ethers.getContractAt(contractName, address);
  const currentOwner: string = await contract.owner();
  console.log(`   current owner: ${currentOwner}`);

  if (currentOwner.toLowerCase() === newOwner.toLowerCase()) {
    console.log("   already owned by the HSM address — nothing to do.");
    return { name: contractName, ok: true, skipped: true, dryRun: false };
  }

  if (currentOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    console.log(
      `   ABORT: deployer (${deployerAddress}) is not the current owner. Refusing to proceed.`,
    );
    return { name: contractName, ok: false, skipped: false, dryRun: false };
  }

  if (!CONFIRM) {
    console.log(
      `   DRY RUN — would call transferOwnership(${newOwner}). Re-run with CONFIRM=true to execute.`,
    );
    return { name: contractName, ok: true, skipped: false, dryRun: true };
  }

  console.log(`   Calling transferOwnership(${newOwner})...`);
  const tx = await contract.transferOwnership(newOwner);
  console.log(`   tx: ${tx.hash} — waiting for confirmation...`);
  await tx.wait();

  // This confirmation read is what Lessons-Learned §16 is about. It ran once, immediately
  // after tx.wait(), against a load-balanced public gateway with no read-your-writes
  // guarantee — hit a backend that had not caught up, returned the OLD owner, and printed
  // a confident `FAILED` for two transfers that had both succeeded.
  //
  // §16 was written on 2026-08-08 and the script was not changed. On 2026-08-15 it did the
  // exact same thing to the CC-082 redeploy. Recording a lesson is not fixing it.
  //
  // So: poll rather than read once, and — more importantly — distinguish "confirmed it did
  // not happen" from "could not confirm". Those are different results and only one of them
  // means the transfer failed.
  const confirmedOwner = await pollForOwner(contract, newOwner);
  const ok = confirmedOwner?.toLowerCase() === newOwner.toLowerCase();

  if (ok) {
    console.log(`   new owner: ${confirmedOwner} — PASS`);
    return { name: contractName, ok: true, skipped: false, dryRun: false };
  }

  console.log(`   last read: ${confirmedOwner ?? "unreadable"} — COULD NOT CONFIRM`);
  console.log(`   The transaction was mined. This is very likely RPC lag, not a failure.`);
  console.log(`   Do NOT re-run. Verify independently before concluding anything:`);
  console.log(`     node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs`);
  console.log(`     https://sepolia.basescan.org/tx/${tx.hash}`);
  return { name: contractName, ok: false, skipped: false, dryRun: false };
}

/**
 * Re-reads owner() until it reports the expected address, or attempts run out.
 *
 * Polls for the value we expect rather than retrying on exception, because the failure mode
 * here is not an error — it is a *successful* read returning stale data. A generic
 * try/catch retry would have caught nothing on 2026-08-08 or 2026-08-15.
 */
async function pollForOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: any,
  expected: string,
  attempts = 8,
): Promise<string | null> {
  let last: string | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = (await contract.owner()) as string;
      if (last.toLowerCase() === expected.toLowerCase()) return last;
    } catch {
      // A codeless-address read on a lagging node throws rather than returning stale data.
      last = null;
    }
    if (i < attempts) {
      console.log(`   owner() not updated yet, re-reading in 5s (${i}/${attempts - 1})...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return last;
}

async function main() {
  // No network/chainType args: connects using whatever --network was passed
  // on the CLI (baseSepolia or base), matching the existing deploy scripts'
  // convention.
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const hsmAddress = addressFromPem(PUB_KEY_PATH, ethers);
  console.log(
    "HSM/KMS target address (derived from docs/carbon-contractors-escrow-signer-1.pub):",
    hsmAddress,
  );

  console.log(
    CONFIRM
      ? "\n*** LIVE RUN — this will send on-chain transactions. ***"
      : "\n*** DRY RUN — no transactions will be sent. Set CONFIRM=true to execute. ***",
  );

  // Sequential, not parallel — both transactions come from the same signer
  // and must not race on nonce assignment.
  const escrowResult = await transferOne(
    ethers,
    "CarbonEscrow",
    // Non-null: checked above.
    ESCROW_ADDRESS as string,
    hsmAddress,
    deployer.address,
  );
  const stakeResult = await transferOne(
    ethers,
    "ReputationStake",
    STAKE_ADDRESS as string,
    hsmAddress,
    deployer.address,
  );

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  for (const r of [escrowResult, stakeResult]) {
    const suffix = r.skipped ? " (already transferred)" : r.dryRun ? " (dry run)" : "";
    console.log(`  ${r.name}: ${r.ok ? "OK" : "FAILED"}${suffix}`);
  }

  if (!escrowResult.ok || !stakeResult.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
