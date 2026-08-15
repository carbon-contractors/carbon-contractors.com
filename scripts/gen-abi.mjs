/**
 * gen-abi.mjs — regenerates src/lib/contracts/*-abi.ts from the Hardhat artifacts.
 *
 * Why this exists (CC-082): the ABI files were maintained by hand, which makes them a
 * silent-drift hazard of exactly the kind this repo keeps getting bitten by. A hand-typed
 * ABI that is missing a function is indistinguishable from a contract that does not have
 * one — the call just reverts, or worse, decodes wrong. CarbonEscrow v2 has twelve struct
 * fields and an eight-field EIP-712 verdict tuple; transcribing that by hand once is a
 * mistake, and transcribing it again on the next change is a certainty.
 *
 * Usage:
 *   npm run compile && npm run gen:abi
 *
 * CI runs `npm run gen:abi -- --check`, which fails if the committed file differs from
 * what the artifact produces. That is the actual guarantee — the generator only helps if
 * something notices when it has not been re-run.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  {
    artifact: "artifacts/contracts/CarbonEscrow.sol/CarbonEscrow.json",
    out: "src/lib/contracts/escrow-abi.ts",
    exportName: "CARBON_ESCROW_ABI",
    source: "contracts/CarbonEscrow.sol",
  },
  {
    artifact: "artifacts/contracts/ReputationStake.sol/ReputationStake.json",
    out: "src/lib/contracts/reputation-abi.ts",
    exportName: "REPUTATION_STAKE_ABI",
    source: "contracts/ReputationStake.sol",
  },
];

/** Stable ordering so a recompile never reshuffles the file and creates a noise diff. */
const KIND_ORDER = { constructor: 0, function: 1, event: 2, error: 3, fallback: 4, receive: 5 };

function sortAbi(abi) {
  return [...abi].sort((a, b) => {
    const ka = KIND_ORDER[a.type] ?? 99;
    const kb = KIND_ORDER[b.type] ?? 99;
    if (ka !== kb) return ka - kb;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

function render({ exportName, source }, abi) {
  const header = `/**
 * ${exportName.toLowerCase().replace(/_/g, "-")}.ts
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with:  npm run compile && npm run gen:abi
 *
 * Source: ${source}
 * Generator: scripts/gen-abi.mjs
 */

export const ${exportName} = ${JSON.stringify(sortAbi(abi), null, 2)} as const;
`;
  // Match the repo's 2-space, double-quote style; JSON.stringify already gives us that.
  return header;
}

const check = process.argv.includes("--check");
let drifted = false;

for (const target of TARGETS) {
  const artifactPath = resolve(ROOT, target.artifact);
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    console.error(`✗ missing artifact ${target.artifact} — run \`npm run compile\` first`);
    process.exit(1);
  }

  const rendered = render(target, artifact.abi);
  const outPath = resolve(ROOT, target.out);

  let existing = null;
  try {
    existing = readFileSync(outPath, "utf8");
  } catch {
    /* first generation */
  }

  if (existing === rendered) {
    console.log(`✓ ${target.out} up to date`);
    continue;
  }

  if (check) {
    console.error(`✗ ${target.out} is stale — run \`npm run compile && npm run gen:abi\``);
    drifted = true;
    continue;
  }

  // write_bytes equivalent: Buffer, not a string, so Node cannot be talked into CRLF on
  // Windows. .gitattributes pins `* text=auto eol=lf` and a CRLF file shows the whole
  // tree as modified — see CLAUDE.md.
  writeFileSync(outPath, Buffer.from(rendered, "utf8"));
  console.log(`✓ wrote ${target.out}`);
}

if (drifted) process.exit(1);
