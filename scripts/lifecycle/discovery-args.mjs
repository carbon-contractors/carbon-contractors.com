/**
 * discovery-args.mjs — CLI argument parsing for the CC-032 discovery-stage harness.
 *
 * Pure, unit-tested. Same conventions as args.mjs (CC-077): `--flag=value`
 * only, two boolean mode flags, one case flag per run.
 */

import { DISCOVERY_CASES_BY_FLAG } from "./discovery-cases.mjs";

export const DISCOVERY_USAGE = `usage: node scripts/lifecycle/discovery-stage.mjs [--dry-run | --execute] [--generate-wallet] [case flag]

mode    --dry-run   validate config, print the exact plan, contact nothing (default)
        --execute   run the discovery pass for real against the deployment

wallet  --generate-wallet   mint an ephemeral throwaway EOA for this run (preferred —
                            nothing lands on disk; discarded when the process exits).
                            Otherwise DISCOVERY_WALLET_PRIVATE_KEY from the env
                            (a throwaway key, never the deployer or agent key).

cases   one flag per run, from CC-032's discovery scope:
${Object.values(DISCOVERY_CASES_BY_FLAG)
  .map((c) => `          ${c.flag.padEnd(30)} ${c.title}`)
  .join("\n")}

The default (no case flag) is the systematic discovery pass.`;

/**
 * @param {string[]} argv — process.argv.slice(2)
 * @returns {{ dryRun: boolean, execute: boolean, generateWallet: boolean, caseKeys: string[], flags: string[] }}
 * @throws {Error} listing every problem at once, with usage guidance.
 */
export function parseDiscoveryArgs(argv) {
  const problems = [];
  const parsed = {
    dryRun: false,
    execute: false,
    generateWallet: false,
    caseKeys: [],
    flags: [],
  };

  for (const arg of argv) {
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--execute") parsed.execute = true;
    else if (arg === "--generate-wallet") parsed.generateWallet = true;
    else if (DISCOVERY_CASES_BY_FLAG[arg]) parsed.caseKeys.push(DISCOVERY_CASES_BY_FLAG[arg].caseKey);
    else {
      problems.push(`unknown flag "${arg}"`);
      parsed.flags.push(arg);
    }
  }

  if (parsed.dryRun && parsed.execute) {
    problems.push("--dry-run and --execute are mutually exclusive");
  }

  if (problems.length > 0) {
    const err = new Error(
      `bad arguments: ${problems.join("; ")}.`,
    );
    err.usage = DISCOVERY_USAGE;
    throw err;
  }
  return parsed;
}
