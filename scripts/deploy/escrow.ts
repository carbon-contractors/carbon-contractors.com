/**
 * deploy/escrow.ts
 * Deploys CarbonEscrow to Base Sepolia.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/escrow.ts --network baseSepolia
 *
 * Requires in .env.local:
 *   DEPLOYER_PRIVATE_KEY=0x...
 *   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org  (optional, defaults to public RPC)
 */

import { ethers } from "hardhat";

// USDC on Base Sepolia (Circle's official test token)
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Deployer has no ETH. Get some from faucet.base.org");
  }

  console.log("\nDeploying CarbonEscrow...");
  console.log("USDC address:", BASE_SEPOLIA_USDC);

  const CarbonEscrow = await ethers.getContractFactory("CarbonEscrow");
  const escrow = await CarbonEscrow.deploy(BASE_SEPOLIA_USDC);
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
  console.log("  Matches expected:", usdc.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
