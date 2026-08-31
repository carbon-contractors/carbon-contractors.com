/**
 * verify-eas-deployment.mjs — READ-ONLY. CC-036, ADR-0008.
 *
 * Turns "I found two addresses on a webpage" into "the chain corroborates one address".
 *
 * ## Why this exists
 *
 * ADR-0008 needs the EAS and SchemaRegistry addresses per network. They are not derivable,
 * so they have to come from EAS's own deployment list — and a transcription error there is
 * silent: attestations encode fine, sign fine, and reference nothing.
 *
 * You only need to source **one** of the two. `EAS.getSchemaRegistry()` returns the registry
 * that EAS itself uses, so the second address comes off the chain rather than out of a
 * browser tab. This script reads it, then checks the pair corroborate each other:
 *
 *   1. the candidate has bytecode on the network you named
 *   2. it answers `version()` — EAS contracts are Semver
 *   3. `getSchemaRegistry()` returns an address that also has bytecode and a `version()`
 *   4. that registry answers `getSchema()` with the zero record for a random UID, which is
 *      the SchemaRegistry interface behaving correctly rather than some other contract
 *
 * **What this does not prove.** Interface corroboration is not provenance. Two contracts
 * pointing at each other with the right shapes is strong evidence and not a certificate —
 * a lookalike pair would pass. Cross-check the address against Basescan showing a verified
 * contract named `EAS`, and against EAS's deployment list. This script's job is to catch the
 * likely failure (wrong network, typo, registry/EAS swapped), not an adversary.
 *
 *   node scripts/audit/verify-eas-deployment.mjs --eas=0x... --network=testnet
 *   node --env-file=.env.local scripts/audit/verify-eas-deployment.mjs
 *
 * Executes no writes and sends no transactions.
 *
 * Exit codes: 0 corroborated · 1 failed a check · 2 misconfigured · 3 transient RPC
 */

import { createPublicClient, http, getAddress, isAddress, keccak256, toHex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { withRpcRetry, isTransient, shortError } from "./rpc-retry.mjs";

const SEMVER_ABI = [
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

const EAS_ABI = [
  ...SEMVER_ABI,
  {
    type: "function",
    name: "getSchemaRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  { type: "function", name: "getName", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  // The EIP-712 envelope for a DELEGATED attestation, read off the chain rather than
  // transcribed from documentation. See the report at the end of main() for why that
  // distinction is the whole point of this addition.
  { type: "function", name: "getDomainSeparator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "getAttestTypeHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
];

const REGISTRY_ABI = [
  ...SEMVER_ABI,
  {
    type: "function",
    name: "getSchema",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
      },
    ],
  },
];

const ZERO_UID = `0x${"00".repeat(32)}`;
const mark = (ok) => (ok ? "PASS" : "FAIL");

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

  const network = arg("network") ?? process.env.NEXT_PUBLIC_BASE_NETWORK ?? "testnet";
  const mainnet = network === "mainnet";
  const rpcUrl = mainnet ? process.env.BASE_MAINNET_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;

  const easRaw = arg("eas") ?? process.env.EAS_ADDRESS;
  if (!easRaw || !isAddress(easRaw)) {
    console.error("MISCONFIGURED: EAS_ADDRESS is required (or --eas=0x...).");
    console.error("");
    console.error("Source it from EAS's own deployment list — docs.attest.org, or the");
    console.error("deployments/ directory in ethereum-attestation-service/eas-contracts.");
    console.error("Base's own docs list it too. Then run this, which reads the SchemaRegistry");
    console.error("address off EAS rather than making you transcribe a second one.");
    return 2;
  }

  const eas = getAddress(easRaw);
  const chain = mainnet ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl || undefined) });

  console.log("── EAS deployment ───────────────────────────────────────────────");
  console.log(`network    ${network} (chain ${chain.id})`);
  console.log(`candidate  ${eas}`);
  console.log(`rpc        ${rpcUrl ? "dedicated endpoint" : "PUBLIC FALLBACK — rate limited, CC-048"}`);
  console.log("");

  let easVersion, easName, registryRaw;
  try {
    const code = await withRpcRetry("getCode", () => client.getCode({ address: eas }));
    if (!code || code === "0x") {
      console.error(`FAIL  no bytecode at ${eas} on ${network}.`);
      console.error("Most likely the address belongs to a different network — EAS is deployed");
      console.error("at a different address on Base and Base Sepolia.");
      return 1;
    }
    console.log(`bytecode present      ${mark(true)}  ${(code.length - 2) / 2} bytes`);

    easVersion = await withRpcRetry("version", () =>
      client.readContract({ address: eas, abi: EAS_ABI, functionName: "version" }),
    );
    easName = await withRpcRetry("getName", () =>
      client.readContract({ address: eas, abi: EAS_ABI, functionName: "getName" }),
    );
    registryRaw = await withRpcRetry("getSchemaRegistry", () =>
      client.readContract({ address: eas, abi: EAS_ABI, functionName: "getSchemaRegistry" }),
    );
  } catch (err) {
    if (isTransient(err)) {
      console.error(`TRANSIENT — RPC unreachable after retries: ${shortError(err)}`);
      return 3;
    }
    console.error(`FAIL  this address has bytecode but does not behave like EAS.`);
    console.error(`      ${shortError(err)}`);
    console.error("");
    console.error("Check you have the EAS address and not the SchemaRegistry — the two are");
    console.error("easy to swap, and the registry has no getSchemaRegistry() to read.");
    return 1;
  }

  console.log(`EAS.version()         ${mark(true)}  ${easVersion}`);
  console.log(`EAS.getName()         ${mark(easName === "EAS")}  ${easName}`);

  if (!isAddress(registryRaw) || registryRaw === "0x0000000000000000000000000000000000000000") {
    console.error(`FAIL  getSchemaRegistry() returned ${registryRaw}.`);
    return 1;
  }
  const registry = getAddress(registryRaw);
  console.log(`getSchemaRegistry()   ${mark(true)}  ${registry}`);

  let registryVersion, probe;
  try {
    const rCode = await withRpcRetry("registry getCode", () => client.getCode({ address: registry }));
    if (!rCode || rCode === "0x") {
      console.error(`FAIL  no bytecode at the registry address EAS reported.`);
      return 1;
    }
    registryVersion = await withRpcRetry("registry version", () =>
      client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "version" }),
    );
    // A UID that cannot plausibly be registered. A correct SchemaRegistry answers with the
    // zero record rather than reverting, which is the interface check.
    const nonsenseUid = keccak256(toHex("carbon-contractors-eas-probe-not-a-real-schema"));
    probe = await withRpcRetry("registry getSchema", () =>
      client.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "getSchema",
        args: [nonsenseUid],
      }),
    );
  } catch (err) {
    if (isTransient(err)) {
      console.error(`TRANSIENT — RPC unreachable after retries: ${shortError(err)}`);
      return 3;
    }
    console.error(`FAIL  the reported registry does not behave like a SchemaRegistry.`);
    console.error(`      ${shortError(err)}`);
    return 1;
  }

  console.log(`registry.version()    ${mark(true)}  ${registryVersion}`);
  const probeOk = probe.uid === ZERO_UID;
  console.log(`getSchema() interface  ${mark(probeOk)}  unknown UID returns the zero record`);
  console.log("");

  if (!probeOk) {
    console.error("FAIL — a random UID returned a populated record, which a SchemaRegistry");
    console.error("would not do. This is probably not a SchemaRegistry.");
    return 1;
  }

  // ── The EIP-712 envelope, read rather than assumed ────────────────────────
  //
  // Measured 2026-08-31: Base Sepolia runs EAS 1.2.0 and Base mainnet runs 1.0.1, and their
  // getAttestTypeHash() values DIFFER. So the typed-data envelope for a delegated
  // attestation is not one fact, it is a per-network fact — and a build that hard-codes it
  // signs correctly on one network and produces signatures the other rejects.
  //
  // These are view functions, so nothing needs transcribing from documentation. That is
  // what removed ADR-0008's "the envelope is an external fact we cannot obtain" blocker.
  let domainSeparator = null;
  let attestTypeHash = null;
  try {
    [domainSeparator, attestTypeHash] = await Promise.all([
      withRpcRetry("getDomainSeparator", () =>
        client.readContract({ address: eas, abi: EAS_ABI, functionName: "getDomainSeparator" }),
      ),
      withRpcRetry("getAttestTypeHash", () =>
        client.readContract({ address: eas, abi: EAS_ABI, functionName: "getAttestTypeHash" }),
      ),
    ]);
  } catch (err) {
    if (isTransient(err)) {
      console.error(`TRANSIENT — RPC unreachable after retries: ${shortError(err)}`);
      return 3;
    }
    // Not fatal to the corroboration — the pair is still EAS — but it is fatal to signing.
    console.log(`EIP-712 envelope      ${mark(false)}  could not read: ${shortError(err)}`);
    console.log("Delegated attestations need these. Without them, signing is guesswork.");
    return 1;
  }

  console.log(`getDomainSeparator()  ${mark(true)}  ${domainSeparator}`);
  console.log(`getAttestTypeHash()   ${mark(true)}  ${attestTypeHash}`);
  console.log("");

  const key = mainnet ? "base-mainnet" : "base-sepolia";
  console.log("CORROBORATED — the pair behave like EAS and its SchemaRegistry.");
  console.log("");
  console.log("Paste into chain-constants.json under attestations:");
  console.log("");
  console.log(`  "easAddress":            { "${key}": "${eas}" }`);
  console.log(`  "schemaRegistryAddress": { "${key}": "${registry}" }`);
  console.log(`  "easVersion":            { "${key}": "${easVersion}" }`);
  console.log(`  "domainSeparator":       { "${key}": "${domainSeparator}" }`);
  console.log(`  "attestTypeHash":        { "${key}": "${attestTypeHash}" }`);
  console.log("");
  console.log("The last three are PER-NETWORK and not interchangeable. Base Sepolia and Base");
  console.log("mainnet run different EAS versions with different Attest typehashes, so a");
  console.log("hard-coded envelope signs correctly on one and is rejected by the other. Read");
  console.log("them at runtime; the values above are for cross-checking, not for embedding.");
  console.log("");
  console.log("Then confirm the schema itself:");
  console.log(`  node scripts/audit/verify-eas-schema.mjs --registry=${registry} --network=${network}`);
  console.log("");
  console.log("Caveat, stated plainly: interface corroboration is not provenance. A lookalike");
  console.log("pair would pass this. Cross-check the address against Basescan showing a");
  console.log("verified contract named EAS, and against EAS's own deployment list. What this");
  console.log("catches is the likely mistake — wrong network, a typo, or EAS and the registry");
  console.log("swapped — not an adversary.");
  return 0;
}

// process.exitCode, not process.exit(): an explicit exit while the HTTP transport still
// holds handles crashes libuv on Windows and discards the exit code.
process.exitCode = await main().catch((err) => {
  console.error(`UNEXPECTED: ${err?.stack || err}`);
  return 2;
});
