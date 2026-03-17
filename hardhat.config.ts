import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// Tell ts-node to use the Hardhat-specific tsconfig (CJS compatible).
// The main tsconfig.json uses ESM modules for Next.js.

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const BASE_SEPOLIA_RPC =
  process.env.BASE_SEPOLIA_RPC_URL ??
  "https://sepolia.base.org";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 84532, // Base Sepolia chain ID for local fork testing
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts",
    cache: "./cache",
  },
};

export default config;
