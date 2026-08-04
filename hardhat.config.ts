// Individual plugins rather than @nomicfoundation/hardhat-toolbox-mocha-ethers
// (CC-064): the bundle also pulls in hardhat-verify and hardhat-ignition-ethers,
// neither of which this repo uses, and hardhat-verify's legacy ethers-v5
// dependency chain carries an elliptic advisory with no fix available upstream.
import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchersPlugin from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatKeystorePlugin from "@nomicfoundation/hardhat-keystore";
import hardhatMochaPlugin from "@nomicfoundation/hardhat-mocha";
import hardhatNetworkHelpersPlugin from "@nomicfoundation/hardhat-network-helpers";
import hardhatTypechainPlugin from "@nomicfoundation/hardhat-typechain";
import { configVariable, defineConfig } from "hardhat/config";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const BASE_SEPOLIA_RPC =
  process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const BASE_MAINNET_RPC =
  process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";

export default defineConfig({
  plugins: [
    hardhatEthersPlugin,
    hardhatEthersChaiMatchersPlugin,
    hardhatKeystorePlugin,
    hardhatMochaPlugin,
    hardhatNetworkHelpersPlugin,
    hardhatTypechainPlugin,
  ],
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 1000 },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhat: {
      type: "edr-simulated",
      chainType: "op",
      chainId: 84532, // Base Sepolia chain ID for local fork testing
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    base: {
      type: "http",
      chainType: "op",
      url: BASE_MAINNET_RPC,
      chainId: 8453,
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
