/**
 * verify-eas-schema.mjs — READ-ONLY. CC-036, ADR-0008.
 *
 * Invariant: the completion-attestation schema registered on-chain is byte-identical to the
 * one `src/lib/attestation/schema.ts` encodes against.
 *
 * ## Why this needs a script
 *
 * An EAS schema UID is `keccak256(abi.encodePacked(schema, resolver, revocable))`, so the
 * UID and the schema are the same fact stated twice. If the registered schema differs from
 * ours by a single character, the UID differs, and every attestation we sign references a
 * schema that does not exist. Nothing local would notice: the encoding is valid, the
 * signature is valid, and the attestation is meaningless.
 *
 * That is the same class of defect as a wrong USDC address, and this repo has had a
 * hard-coded address wrong in *both* directions (`CC-059`). So the UID is derived in code
 * and confirmed against the chain here, rather than transcribed anywhere.
 *
 * ## The addresses are deliberately not in this file
 *
 * The EAS SchemaRegistry address differs per network and is not derivable. Guessing it
 * would produce a confident PASS against nothing. Pass it explicitly:
 *
 *   node --env-file=.env.local scripts/audit/verify-eas-schema.mjs
 *   node scripts/audit/verify-eas-schema.mjs --registry=0x... --network=testnet
 *
 * Source it from EAS's own deployment list, record it in `chain-constants.json`, and let
 * this script confirm it — in that order.
 *
 * Executes no writes and sends no transactions.
 *
 * Exit codes: 0 clean · 1 mismatch or not registered · 2 misconfigured · 3 transient RPC
 */

import { createPublicClient, http, getAddress, isAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { withRpcRetry, isTransient, shortError } from "./rpc-retry.mjs";
import {
  COMPLETION_SCHEMA,
  COMPLETION_RESOLVER,
  COMPLETION_REVOCABLE,
  completionSchemaUid,
} from "../../src/lib/attestation/schema.ts";

const SCHEMA_REGISTRY_ABI = [
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

  const registryRaw = arg("registry") ?? process.env.EAS_SCHEMA_REGISTRY_ADDRESS;
  if (!registryRaw || !isAddress(registryRaw)) {
    console.error("MISCONFIGURED: EAS_SCHEMA_REGISTRY_ADDRESS is required (or --registry=0x...).");
    console.error("");
    console.error("Deliberately not defaulted. The address differs per network and is not");
    console.error("derivable, so a guess here would PASS against nothing. Take it from EAS's");
    console.error("own deployment list, record it in chain-constants.json, then re-run this.");
    return 2;
  }

  const registry = getAddress(registryRaw);
  const chain = mainnet ? base : baseSepolia;
  const uid = completionSchemaUid();
  const client = createPublicClient({ chain, transport: http(rpcUrl || undefined) });

  console.log("── EAS completion schema ────────────────────────────────────────");
  console.log(`network    ${network} (chain ${chain.id})`);
  console.log(`registry   ${registry}`);
  console.log(`rpc        ${rpcUrl ? "dedicated endpoint" : "PUBLIC FALLBACK — rate limited, CC-048"}`);
  console.log(`expected   ${uid}`);
  console.log("");

  let record;
  try {
    const code = await withRpcRetry("getCode", () => client.getCode({ address: registry }));
    if (!code || code === "0x") {
      console.error(`FAIL  no bytecode at ${registry} on ${network}.`);
      console.error("Either the address is wrong or it belongs to a different network.");
      return 1;
    }
    record = await withRpcRetry("getSchema", () =>
      client.readContract({
        address: registry,
        abi: SCHEMA_REGISTRY_ABI,
        functionName: "getSchema",
        args: [uid],
      }),
    );
  } catch (err) {
    if (isTransient(err)) {
      console.error(`TRANSIENT — RPC unreachable after retries: ${shortError(err)}`);
      return 3;
    }
    // A revert here usually means the address is a contract but not a SchemaRegistry.
    console.error(`MISCONFIGURED: getSchema read failed: ${shortError(err)}`);
    console.error("If the address has bytecode but this reverts, it is probably not a");
    console.error("SchemaRegistry — check it is the registry and not the EAS contract itself.");
    return 2;
  }

  // EAS returns a zero-UID record for an unregistered schema rather than reverting.
  if (record.uid === ZERO_UID) {
    console.log(`FAIL  schema ${uid} is NOT registered on ${network}.`);
    console.log("");
    console.log("Nothing is broken and no attestation is wrong — none can be issued yet.");
    console.log("Register it once per network, with:");
    console.log("");
    console.log(`  schema     ${COMPLETION_SCHEMA}`);
    console.log(`  resolver   ${COMPLETION_RESOLVER}`);
    console.log(`  revocable  ${COMPLETION_REVOCABLE}`);
    console.log("");
    console.log("Then re-run this. The UID above is derived from those three values, so a");
    console.log("registration that produces a different UID got one of them wrong.");
    return 1;
  }

  const schemaOk = record.schema === COMPLETION_SCHEMA;
  const resolverOk = record.resolver.toLowerCase() === COMPLETION_RESOLVER.toLowerCase();
  const revocableOk = record.revocable === COMPLETION_REVOCABLE;

  console.log(`registered            ${mark(true)}  uid matches`);
  console.log(`schema string         ${mark(schemaOk)}`);
  console.log(`resolver              ${mark(resolverOk)}  ${record.resolver}`);
  console.log(`revocable             ${mark(revocableOk)}  ${record.revocable}`);
  console.log("");

  if (schemaOk && resolverOk && revocableOk) {
    console.log("CLEAN — the registered schema is byte-identical to the one this build encodes.");
    console.log("");
    console.log("Caveat, stated plainly: this proves the schema exists and matches. It proves");
    console.log("nothing about whether any attestation has ever been signed or registered.");
    return 0;
  }

  // Reaching here should be impossible — a differing schema, resolver or revocable flag
  // produces a different UID, so getSchema(uid) would have returned the zero record. If it
  // fires, the UID derivation in schema.ts disagrees with EAS's, which is worse than a
  // mismatch: it means every UID this build computes is wrong.
  console.error("FAIL — the record at this UID does not match the schema that derives it.");
  if (!schemaOk) {
    console.error(`  registered: ${record.schema}`);
    console.error(`  expected:   ${COMPLETION_SCHEMA}`);
  }
  console.error("");
  console.error("This should be unreachable: all three inputs feed the UID, so a mismatch");
  console.error("should have produced an unregistered lookup. Suspect the encodePacked");
  console.error("derivation in src/lib/attestation/schema.ts before suspecting the chain.");
  return 1;
}

// `process.exitCode` rather than `process.exit()`, matching verify-unclaimed.mjs. An
// explicit exit() while the HTTP transport still holds handles crashes libuv on Windows
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) — which discards the exit code
// this script exists to produce, and looks like a script bug rather than a clean FAIL.
process.exitCode = await main().catch((err) => {
  console.error(`UNEXPECTED: ${err?.stack || err}`);
  return 2;
});
