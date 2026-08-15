/**
 * deploy/escrow.ts
 * Deploys CarbonEscrow (v2 — CC-082) to Base Sepolia or Base Mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/escrow.ts --network baseSepolia
 *   npx hardhat run scripts/deploy/escrow.ts --network base
 *
 * Requires in .env.local:
 *   DEPLOYER_PRIVATE_KEY=0x...
 *   NEXT_PUBLIC_USDC_ADDRESS=0x...   USDC contract for the target network
 *   VERDICT_SIGNER_ADDRESS=0x...     platform signer, seeded into the accepted-signer set
 *
 * VERDICT_SIGNER_ADDRESS is the address `npm run verify:kms` prints. Seeding it at
 * construction means the contract can verify a verdict from its first block; leave it
 * unset and you deploy a contract that accepts no verdicts at all until the owner calls
 * setVerdictSigner, which is a working contract with a silently dead settlement path.
 *
 * The script refuses to deploy without it rather than defaulting to address(0).
 */

import { network } from "hardhat";

const USDC_ADDRESS = required(
  "NEXT_PUBLIC_USDC_ADDRESS",
  "USDC contract for the target network.",
);
const VERDICT_SIGNER = required(
  "VERDICT_SIGNER_ADDRESS",
  "Run `npm run verify:kms` to get it. Deploying without it produces a contract whose " +
    "verdict path can never be exercised.",
);

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env.local — ${hint}`);
  return value;
}

/** CC-059 — a fresh deploy is owned by the deployer, and must not stay that way. */
const HSM_OWNER = "0xa8931097540e69B474013D294d0bA6A2cC853e4b";

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Deployer has no ETH.");
  }

  console.log("\nDeploying CarbonEscrow v2...");
  console.log("  USDC:          ", USDC_ADDRESS);
  console.log("  Verdict signer:", VERDICT_SIGNER);

  const escrow = await ethers.deployContract("CarbonEscrow", [USDC_ADDRESS, VERDICT_SIGNER]);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  const receipt = await escrow.deploymentTransaction()?.wait();
  const deployBlock = receipt?.blockNumber;

  console.log("\n✓ CarbonEscrow deployed to:", address);

  // ── Post-deploy verification ────────────────────────────────────────────────
  // Read every constructor-set value back off the chain rather than assuming the
  // arguments took. A wrong USDC address here strands funds; a missing verdict signer
  // leaves settlement dead.
  const [owner, usdc, signerAccepted, minWindow, maxWindow, domain] = await Promise.all([
    escrow.owner(),
    escrow.usdc(),
    escrow.acceptedSigners(VERDICT_SIGNER),
    escrow.MIN_REVIEW_WINDOW(),
    escrow.MAX_REVIEW_WINDOW(),
    escrow.domainSeparator(),
  ]);

  console.log("\nVerification");
  console.log("  usdc()                 ", usdc, usdc.toLowerCase() === USDC_ADDRESS.toLowerCase() ? "✓" : "✗ MISMATCH");
  console.log("  owner()                ", owner);
  console.log("  acceptedSigners(signer)", signerAccepted, signerAccepted ? "✓" : "✗ NOT SEEDED");
  console.log("  MIN_REVIEW_WINDOW      ", `${minWindow}s`);
  console.log("  MAX_REVIEW_WINDOW      ", `${maxWindow}s`);
  console.log("  EIP-712 domain         ", domain);

  const ownerIsHsm = owner.toLowerCase() === HSM_OWNER.toLowerCase();

  console.log("\n" + "─".repeat(72));
  console.log("NEXT STEPS — none of these are optional");
  console.log("─".repeat(72));
  console.log("\n1. .env.local and Vercel:");
  console.log(`     NEXT_PUBLIC_ESCROW_CONTRACT=${address}`);
  if (deployBlock !== undefined) {
    console.log(`     ESCROW_DEPLOY_BLOCK=${deployBlock}`);
  } else {
    console.log("     ESCROW_DEPLOY_BLOCK=  (run scripts/audit/find-deploy-block.mjs)");
  }
  console.log("\n   NEXT_PUBLIC_* is inlined at build time — redeploy on Vercel or the");
  console.log("   change does nothing (CC-014).");

  if (!ownerIsHsm) {
    console.log("\n2. Transfer ownership to the HSM key — CC-059. The contract is owned by");
    console.log(`   the deployer (${owner}) right now, which is not where it should stay:`);
    console.log("\n     npm run transfer:ownership");
    console.log(`\n   Expected owner afterwards: ${HSM_OWNER}`);
  } else {
    console.log("\n2. Ownership already sits with the HSM key. ✓");
  }

  console.log("\n3. Verify against the live chain, do not trust this output:");
  console.log("     node --env-file=.env.local scripts/audit/verify-contract-owner.mjs");
  console.log("     node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs");
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
