/**
 * deploy/reputation-stake.ts
 * Deploys ReputationStake to Base Sepolia or Base Mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/reputation-stake.ts --network baseSepolia
 *   npx hardhat run scripts/deploy/reputation-stake.ts --network base
 *
 * Requires in .env.local:
 *   DEPLOYER_PRIVATE_KEY=0x...
 *   NEXT_PUBLIC_USDC_ADDRESS=0x...  (USDC contract for target network)
 */

import { ethers } from "hardhat";

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS;
if (!USDC_ADDRESS) {
  throw new Error("NEXT_PUBLIC_USDC_ADDRESS must be set in .env.local");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Deployer has no ETH.");
  }

  console.log("\nDeploying ReputationStake...");
  console.log("USDC address:", USDC_ADDRESS);

  const ReputationStake = await ethers.getContractFactory("ReputationStake");
  const stake = await ReputationStake.deploy(USDC_ADDRESS);
  await stake.waitForDeployment();

  const address = await stake.getAddress();
  console.log("\n✓ ReputationStake deployed to:", address);
  console.log("\nUpdate .env.local:");
  console.log(`  NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT=${address}`);

  // Verify deployment
  const owner = await stake.owner();
  const usdc = await stake.usdc();
  const minStake = await stake.minStake();
  console.log("\nVerification:");
  console.log("  Owner:", owner);
  console.log("  USDC:", usdc);
  console.log("  Min stake:", ethers.formatUnits(minStake, 6), "USDC");
  console.log(
    "  USDC matches:",
    usdc.toLowerCase() === USDC_ADDRESS.toLowerCase()
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
