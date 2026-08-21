/**
 * verify-contract-owner.mjs — READ-ONLY. CC-052 / CC-059.
 *
 * Answers one question that has been asserted in both directions and measured in
 * neither: which key actually holds owner authority on the deployed contracts?
 *
 * Compares three addresses:
 *   1. KMS/HSM address — derived OFFLINE from docs/carbon-contractors-escrow-signer-1.pub.
 *      No KMS call, no gcloud, no credentials. Mirrors getEthAddressFromKms() in
 *      src/lib/contracts/kms-signer.ts so a divergence in that logic shows up here.
 *   2. Local dev address — derived from DEPLOYER_PRIVATE_KEY. The ADDRESS is printed;
 *      key material never is.
 *   3. On-chain owner() — read from the deployed contracts.
 *
 * Also probes the DEPLOYED runtime bytecode for the "only agent" revert string, which
 * settles whether completeTask() is agent-gated on chain rather than only in the local
 * source. This matters because completeTaskOnChain() calls it as the platform signer,
 * which cannot satisfy that check under any key. See CC-037.
 *
 * Executes no writes and sends no transactions.
 *
 *   node --env-file=.env.local scripts/audit/verify-contract-owner.mjs
 *
 * Exit codes: 0 pass · 1 unexpected or local owner · 2 misconfigured · 3 transient RPC failure
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  keccak256,
  getAddress,
  formatEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { withRpcRetry, isTransient, shortError } from "./rpc-retry.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB_KEY = join(REPO, "docs", "carbon-contractors-escrow-signer-1.pub");
const line = (n = 74) => "=".repeat(n);
const eq = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * Derive an Ethereum address from a secp256k1 SubjectPublicKeyInfo PEM.
 * The uncompressed EC point (0x04 || x || y) is always the last 65 bytes of the DER.
 */
function addressFromPem(path) {
  const body = readFileSync(path, "utf8")
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error(
      `Expected uncompressed EC point (0x04 prefix), got 0x${point[0].toString(16)}`,
    );
  }
  const hash = keccak256("0x" + Buffer.from(point.subarray(1)).toString("hex"));
  return getAddress("0x" + hash.slice(-40));
}

const OWNER_ABI = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const VIEW_ABI = [
  { name: "usdc", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "totalLocked", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

console.log(line());
console.log("Contract owner verification (read-only) — CC-052 / CC-059");
console.log(line());

// ── 1. HSM address, offline ──────────────────────────────────────────────────
const kmsAddress = addressFromPem(PUB_KEY);
console.log("\n[1] KMS/HSM address, derived offline from the committed public key");
console.log(`    ${kmsAddress}`);

// ── 2. Local dev key address ─────────────────────────────────────────────────
let localAddress = null;
console.log("\n[2] Local DEPLOYER_PRIVATE_KEY -> address (key material not printed)");
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) {
  console.log("    DEPLOYER_PRIVATE_KEY not set — skipping");
} else {
  try {
    localAddress = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`).address;
    console.log(`    ${localAddress}`);
  } catch (err) {
    console.log(`    could not derive an address: ${err.message}`);
  }
}

// ── 3. On-chain reads ────────────────────────────────────────────────────────
const mainnet = process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet";
const chain = mainnet ? base : baseSepolia;
const rpcUrl =
  (mainnet ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) ||
  chain.rpcUrls.default.http[0];

console.log(`\n[3] On-chain reads — ${chain.name} via ${rpcUrl}`);
if (!process.env.BASE_SEPOLIA_RPC_URL && !mainnet) {
  console.log("    (using the public endpoint — rate-limited; see CC-048)");
}

const client = createPublicClient({ chain, transport: http(rpcUrl) });
const owners = {};
let readError = null;

for (const [name, address] of [
  ["CarbonEscrow", process.env.NEXT_PUBLIC_ESCROW_CONTRACT],
  ["ReputationStake", process.env.NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT],
]) {
  console.log(`\n    ── ${name} @ ${address ?? "(not configured)"}`);
  if (!address) continue;
  try {
    const code = await withRpcRetry(`${name} code`, () => client.getCode({ address }));
    if (!code || code === "0x") {
      console.log("       no contract deployed at this address");
      continue;
    }
    console.log(`       bytecode:      ${(code.length - 2) / 2} bytes`);

    owners[name] = await withRpcRetry(`${name} owner`, () =>
      client.readContract({ address, abi: OWNER_ABI, functionName: "owner" }),
    );
    console.log(`       owner():       ${owners[name]}`);

    for (const fn of VIEW_ABI) {
      try {
        const value = await withRpcRetry(`${name} ${fn.name}`, () =>
          client.readContract({ address, abi: VIEW_ABI, functionName: fn.name }),
        );
        console.log(`       ${(fn.name + "():").padEnd(15)}${value}`);
      } catch {
        /* function not present on this contract */
      }
    }

    // Is completeTask() agent-gated in the DEPLOYED code, not just in the source?
    if (name === "CarbonEscrow") {
      const present = code.includes(toHex("only agent").slice(2));
      console.log(`       completeTask "only agent" require present on chain: ${present}`);
    }
  } catch (err) {
    readError = err;
    console.log(`       read failed: ${err.shortMessage ?? err.message}`);
  }
}

// ── 4. Balances — an authorised signer with no gas is its own outage ─────────
console.log("\n[4] Native balances");
const labelled = new Map([[kmsAddress, "KMS/HSM (docs/*.pub)"]]);
if (localAddress) labelled.set(localAddress, "local DEPLOYER_PRIVATE_KEY");
for (const [name, owner] of Object.entries(owners)) {
  if (!labelled.has(owner)) labelled.set(owner, `${name}.owner()`);
}
for (const [address, label] of labelled) {
  try {
    const balance = await withRpcRetry("balance", () => client.getBalance({ address }));
    console.log(`    ${address}  ${formatEther(balance).padStart(20)} ETH   ${label}`);
  } catch (err) {
    console.log(`    ${address}  balance read failed: ${err.shortMessage ?? err.message}`);
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("\n" + line());
console.log("VERDICT");
console.log(line());

const escrowOwner = owners.CarbonEscrow;
if (!escrowOwner) {
  if (readError && isTransient(readError)) {
    console.log(`  TRANSIENT — RPC unreachable after retries: ${shortError(readError)}`);
    process.exitCode = 3;
  } else if (readError) {
    console.log(`  MISCONFIGURED: RPC read failed: ${shortError(readError)}`);
    process.exitCode = 2;
  } else {
    console.log("  Could not read CarbonEscrow.owner() — inconclusive, do not draw a conclusion.");
    process.exitCode = 1;
  }
} else if (eq(escrowOwner, kmsAddress)) {
  console.log("  PASS — the escrow is owned by the HSM-derived address.");
  console.log("  docs/Security-Trust-Disclosure.md can state this as verified.");
} else if (eq(escrowOwner, localAddress)) {
  console.log("  FAIL — the escrow is owned by the RAW LOCAL KEY, not the HSM key.");
  console.log(`    owner():  ${escrowOwner}`);
  console.log(`    HSM key:  ${kmsAddress}`);
  console.log("  transferOwnership() to the HSM address has never been performed.");
  console.log("  See CC-059. Do not deploy to mainnet in this state (CC-039).");
  process.exitCode = 1;
} else {
  console.log("  UNEXPECTED — owner() is neither the HSM key nor the local key.");
  console.log(`    owner():  ${escrowOwner}`);
  console.log("  A third address holds authority. Explain this before doing anything else.");
  process.exitCode = 1;
}

console.log("");
console.log("  Independent of ownership: completeTask() is gated on msg.sender == task.agent,");
console.log("  not on owner. completeTaskOnChain() calls it as the platform signer, so that");
console.log("  path cannot succeed for any key. That is CC-037, not an ownership problem.");
console.log(line());
