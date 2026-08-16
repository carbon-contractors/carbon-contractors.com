/**
 * verify-signer.mjs — READ-ONLY. CC-085, ADR-0003 D2.
 *
 * Invariant: the verdict signer can produce a signature the deployed contract will
 * actually accept.
 *
 * Violation means settlement silently degrades to auto-release. Post-Amendment 1 the
 * platform makes no transaction in the settlement path, so there is no failed transaction
 * to alert on — the absence of a usable signature IS the failure, and absence is not an
 * event (ADR-0003 D3). Every task in flight then resolves on the D6 liveness default:
 * window closes, worker claims, evidence quality never enters into it.
 *
 * `npm run verify:kms` already proves the KMS key can sign and that the signature
 * recovers to the derived address. It does NOT prove any of the four things below, and
 * each of them fails silently:
 *
 *   1. acceptedSigners[signer] — a signer the contract does not accept produces
 *      signatures that revert VerdictSignerNotAccepted() on every claim and dispute.
 *      A redeploy seeds this set in the constructor; a key rotation does not.
 *   2. domainSeparator() — EIP-712 binds the signature to (name, version, chainId,
 *      verifyingContract). Redeploying changes verifyingContract, so a signer still
 *      hashing against the OLD escrow address produces perfectly valid signatures that
 *      this contract will never recover to an accepted address. It looks like a bad key,
 *      it is a stale address, and nothing errors until money is on the line.
 *   3. VERDICT_TYPEHASH — the field list and their order are part of the digest. A
 *      struct change without a matching signer change is the same silent failure.
 *   4. that the address the contract accepts is the same address KMS actually holds.
 *
 * Checks 1-3 need no credentials and run everywhere. Check 4 needs a live KMS round trip
 * and is SKIPPED (loudly, never silently) when no credentials are present — see the
 * --require-kms flag and the ADC note below.
 *
 * ## KMS credentials expire, and the failure looks like broken config
 *
 * A plain `gcloud auth application-default login` CANNOT sign: the signing role sits on
 * kms-signer-svc and Aaron holds only serviceAccountTokenCreator scoped to it. The
 * session is impersonated and it lapses — a lapsed one fails as a 400 reading
 * `unable to impersonate ... "error_subtype":"invalid_rapt"`. That is an expired login,
 * not a misconfiguration. Re-auth with (CC-059):
 *
 *   gcloud auth application-default login \
 *     --impersonate-service-account=kms-signer-svc@carbon-contractors.iam.gserviceaccount.com
 *
 * Executes no writes and sends no transactions. Prints only public addresses and hashes —
 * never key material.
 *
 *   node --env-file=.env.local scripts/audit/verify-signer.mjs
 *   node --env-file=.env.local scripts/audit/verify-signer.mjs --require-kms
 *   node --env-file=.env.local scripts/audit/verify-signer.mjs --no-kms
 *   node --env-file=.env.local scripts/audit/verify-signer.mjs --signer=0xNewKey
 *
 * `--signer` checks an address other than the one the committed public key derives to.
 * The reason it exists is key rotation: you want to know setVerdictSigner() landed for the
 * NEW key before you start signing with it, and afterwards that the old one was removed.
 * It implies --no-kms, since KMS holds only the one key.
 *
 * Exit codes: 0 clean · 1 violation · 2 misconfigured or RPC failure
 *
 * Note: sets `process.exitCode` rather than calling process.exit(), for the Windows
 * libuv reason documented at the top of verify-escrow-solvency.mjs.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  stringToHex,
  hashDomain,
} from "viem";
import { base, baseSepolia } from "viem/chains";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB_KEY = join(REPO, "docs", "carbon-contractors-escrow-signer-1.pub");

/**
 * Must match CarbonEscrow's EIP712("CarbonEscrow", "2") constructor argument and the
 * VERDICT_TYPEHASH string literal. Deliberately written out here rather than imported:
 * the point of the check is to compare an independent statement of the intent against
 * what the deployed bytecode reports. Importing the contract's own answer would compare
 * it with itself.
 */
const EIP712_NAME = "CarbonEscrow";
const EIP712_VERSION = "2";
const VERDICT_TYPE_STRING =
  "Verdict(bytes32 taskId,bytes32 specHash,bytes32 evidenceHash,bytes32 checkerHash,bool passed,bytes32 breakdownHash,uint256 expiry,uint256 nonce)";

const EIP712_DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
};

const ESCROW_ABI = [
  {
    type: "function",
    name: "acceptedSigners",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "domainSeparator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "VERDICT_TYPEHASH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
];

/**
 * Derive an Ethereum address from a secp256k1 SubjectPublicKeyInfo PEM, offline.
 * Mirrors getEthAddressFromKms() in src/lib/contracts/kms-signer.ts — the uncompressed
 * EC point (0x04 || x || y) is always the last 65 bytes of the DER.
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
  return getAddress("0x" + keccak256("0x" + Buffer.from(point.subarray(1)).toString("hex")).slice(-40));
}

/**
 * Run the real KMS round trip by delegating to scripts/verify-kms-signer.ts.
 *
 * Deliberately a child process rather than an import: that script is TypeScript behind
 * the `@/` path alias, so a plain .mjs cannot load it, and reimplementing the DER -> r/s/v
 * conversion here would create a second copy of the crypto that could drift out of
 * agreement with the one production uses without either copy erroring.
 *
 * Returns { ran, ok, address, detail }.
 */
function runKmsRoundTrip() {
  return new Promise((resolve) => {
    // One fixed literal, no interpolation, no user input — and passed as a command
    // string rather than an args array, because `shell: true` with an args array trips
    // Node's DEP0190 warning. `shell: true` is required at all on Windows, where npm is
    // a .cmd and Node refuses to spawn those directly (CVE-2024-27980).
    const child = spawn("npm run --silent verify:kms", {
      cwd: REPO,
      shell: true,
      env: process.env,
    });

    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) =>
      resolve({ ran: false, ok: false, address: null, detail: err.message }),
    );
    child.on("close", (code) => {
      const match = out.match(/DERIVED ADDRESS:\s*(0x[0-9a-fA-F]{40})/);
      const impersonation = /invalid_rapt|unable to impersonate/i.test(out);
      const firstError =
        out
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /error|fail|denied|permission/i.test(l)) ?? "";
      resolve({
        ran: true,
        ok: code === 0,
        address: match ? getAddress(match[1]) : null,
        detail: impersonation
          ? "ADC session is not impersonated, or has expired (invalid_rapt) — re-run the gcloud command in this file's header"
          : firstError,
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const requireKms = args.includes("--require-kms");
  const signerOverrideRaw = args.find((a) => a.startsWith("--signer="))?.slice("--signer=".length);
  const noKms = args.includes("--no-kms") || Boolean(signerOverrideRaw);

  const escrowRaw = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK || "testnet";
  const mainnet = network === "mainnet";
  const rpcUrl = mainnet
    ? process.env.BASE_MAINNET_RPC_URL
    : process.env.BASE_SEPOLIA_RPC_URL;

  if (!escrowRaw) {
    console.error("MISCONFIGURED: NEXT_PUBLIC_ESCROW_CONTRACT is required.");
    return 2;
  }

  const escrow = getAddress(escrowRaw);
  const chain = mainnet ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(rpcUrl || undefined) });

  console.log("── Verdict signer ───────────────────────────────────────────────");
  console.log(`network   ${network} (chain ${chain.id})`);
  console.log(`escrow    ${escrow}`);
  console.log(
    `rpc       ${rpcUrl ? "dedicated endpoint" : "PUBLIC FALLBACK — rate limited, see CC-048"}`,
  );
  console.log("");

  // ── The signer this repo believes it has ──────────────────────────────────
  let hsmAddress;
  try {
    hsmAddress = signerOverrideRaw ? getAddress(signerOverrideRaw) : addressFromPem(PUB_KEY);
  } catch (err) {
    console.error(
      signerOverrideRaw
        ? `MISCONFIGURED: --signer=${signerOverrideRaw} is not a valid address.`
        : `MISCONFIGURED: could not derive the HSM address from ${PUB_KEY}`,
    );
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log(
    `signer ${(signerOverrideRaw ? "(--signer override)" : "(from committed .pub)").padEnd(22)} ${hsmAddress}`,
  );

  // Only meaningful against the real signer — under --signer the env var is expected to
  // still name the current one, so comparing them would be a false positive.
  const envSigner = signerOverrideRaw ? undefined : process.env.VERDICT_SIGNER_ADDRESS;
  if (!signerOverrideRaw) {
    console.log(`VERDICT_SIGNER_ADDRESS         ${envSigner ?? "(unset)"}`);
  }
  console.log("");

  // ── On-chain reads ────────────────────────────────────────────────────────
  let accepted, onChainDomain, onChainTypehash;
  try {
    [accepted, onChainDomain, onChainTypehash] = await Promise.all([
      client.readContract({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "acceptedSigners",
        args: [hsmAddress],
      }),
      client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "domainSeparator" }),
      client.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "VERDICT_TYPEHASH" }),
    ]);
  } catch (err) {
    console.error(`RPC read failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("A v1 escrow has none of these functions — check NEXT_PUBLIC_ESCROW_CONTRACT");
    console.error("points at the v2 deployment (CC-082).");
    return 2;
  }

  const expectedDomain = hashDomain({
    domain: {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId: chain.id,
      verifyingContract: escrow,
    },
    types: EIP712_DOMAIN_TYPES,
  });
  const expectedTypehash = keccak256(stringToHex(VERDICT_TYPE_STRING));

  const failures = [];

  // 1 — the contract accepts this signer
  console.log(`[1] acceptedSigners(signer)     ${accepted}`);
  if (!accepted) {
    failures.push(
      "the deployed escrow does NOT accept this signer — every claimWithVerdict and " +
        "disputeTask presenting its signature reverts VerdictSignerNotAccepted(). " +
        "Fix with setVerdictSigner(signer, true) from the owner key.",
    );
  }

  // 1b — the env var agrees, if it is set at all
  if (envSigner && getAddress(envSigner) !== hsmAddress) {
    failures.push(
      `VERDICT_SIGNER_ADDRESS (${getAddress(envSigner)}) is not the address the committed ` +
        `public key derives to (${hsmAddress}). One of them is stale; the deploy script seeds ` +
        "the accepted-signer set from the env var, so this decides which key can settle.",
    );
  }

  // 2 — EIP-712 domain
  console.log(`[2] domainSeparator()           ${onChainDomain}`);
  console.log(`    computed for this escrow    ${expectedDomain}`);
  if (onChainDomain !== expectedDomain) {
    failures.push(
      `EIP-712 domain separator mismatch. A signer hashing against ${expectedDomain} produces ` +
        "signatures this contract will never recover to an accepted address. The usual cause " +
        "is a redeploy: verifyingContract is part of the domain, so the address changing " +
        "invalidates every signature shaped for the old one.",
    );
  }

  // 3 — verdict struct typehash
  console.log(`[3] VERDICT_TYPEHASH()          ${onChainTypehash}`);
  console.log(`    computed from the struct    ${expectedTypehash}`);
  if (onChainTypehash !== expectedTypehash) {
    failures.push(
      "VERDICT_TYPEHASH mismatch — the deployed Verdict struct is not the one this repo " +
        "signs. Field names, types and order are all part of the digest.",
    );
  }
  console.log("");

  // 4 — can the key actually sign, and is it the key the contract accepts?
  if (noKms) {
    console.log("[4] KMS round trip              SKIPPED (--no-kms)");
    console.log("    Checks 1-3 prove the contract is configured for this signer. They do");
    console.log("    NOT prove the key is reachable or can sign.");
  } else if (!process.env.GCP_KMS_KEY_PATH) {
    console.log("[4] KMS round trip              SKIPPED — GCP_KMS_KEY_PATH is unset");
    if (requireKms) {
      failures.push("--require-kms was passed but GCP_KMS_KEY_PATH is not set.");
    }
  } else {
    console.log("[4] KMS round trip — delegating to `npm run verify:kms` (hits real GCP KMS)");
    const kms = await runKmsRoundTrip();
    if (!kms.ran) {
      console.log(`    could not start the child process: ${kms.detail}`);
      if (requireKms) failures.push(`KMS round trip could not run: ${kms.detail}`);
    } else if (!kms.ok) {
      console.log(`    FAILED${kms.detail ? ` — ${kms.detail}` : ""}`);
      const msg =
        "the verdict signer cannot produce a signature" +
        (kms.detail ? ` — ${kms.detail}` : "");
      // An expired ADC session is an operator problem, not a platform outage. It is
      // only a violation when the run was asked to require KMS (i.e. in an environment
      // that is supposed to have working credentials).
      if (requireKms || !/impersonate|invalid_rapt|credential|ADC/i.test(kms.detail)) {
        failures.push(msg);
      } else {
        console.log("    Treated as SKIPPED: this looks like a local credential lapse rather");
        console.log("    than a signer failure. Re-run with --require-kms to make it fatal.");
      }
    } else {
      console.log(`    signed and recovered            ${kms.address}`);
      if (kms.address !== hsmAddress) {
        failures.push(
          `KMS holds ${kms.address} but the contract accepts ${hsmAddress}. The key that can ` +
            "sign is not the key that can settle.",
        );
      } else {
        console.log("    matches the accepted signer     OK");
      }
    }
  }

  console.log("");
  if (failures.length === 0) {
    console.log("CLEAN — the verdict signer is configured for this deployment.");
    return 0;
  }

  console.log(`VIOLATION — ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  · ${f}`);
  console.log("");
  console.log("Consequence: settlement degrades to the ADR-0001 D6 liveness default. Work");
  console.log("submitted with no valid failing verdict presented before the window closes is");
  console.log("claimable by the worker regardless of evidence quality, and nothing errors.");
  return 1;
}

process.exitCode = await main();
