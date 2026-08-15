import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Hardhat build artifacts — generated, not authored (CC-064).
    "artifacts/**",
    "cache/**",
    "typechain-types/**",
    "types/ethers-contracts/**",
    // Agent worktrees are full checkouts of this same repo, so every finding in `src/`
    // gets reported once per live worktree. Three copies of one warning reads as three
    // new problems, which is exactly the wrong signal when you have just edited a file.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
