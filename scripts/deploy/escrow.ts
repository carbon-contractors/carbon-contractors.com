/**
 * deploy/escrow.ts
 * Deploys CarbonEscrow to Base Sepolia or Base Mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/escrow.ts --network baseSepolia
 *   npx hardhat run scripts/deploy/escrow.ts --network base
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

  console.log("\nDeploying CarbonEscrow...");
  console.log("USDC address:", USDC_ADDRESS);

  const CarbonEscrow = await ethers.getContractFactory("CarbonEscrow");
  const escrow = await CarbonEscrow.deploy(USDC_ADDRESS);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  console.log("\n✓ CarbonEscrow deployed to:", address);
  console.log("\nUpdate .env.local:");
  console.log(`  NEXT_PUBLIC_ESCROW_CONTRACT=${address}`);

  // Verify deployment
  const owner = await escrow.owner();
  const usdc = await escrow.usdc();
  console.log("\nVerification:");
  console.log("  Owner:", owner);
  console.log("  USDC:", usdc);
  console.log("  Matches expected:", usdc.toLowerCase() === USDC_ADDRESS.toLowerCase());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
