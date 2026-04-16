/**
 * verify-kms-signer.ts
 *
 * Standalone end-to-end verification script for the KMS signer.
 * Hits real GCP Cloud KMS — no mocks.
 *
 * Verifies:
 *   1. PEM public key parsing + keccak256 address derivation
 *   2. KMS asymmetricSign round-trip (signs a known message)
 *   3. DER -> r/s/v conversion with low-S normalization
 *   4. viem recoverAddress recovers the same address that was derived
 *
 * Usage:
 *   GCP_KMS_KEY_PATH=projects/.../cryptoKeyVersions/1 \
 *   GCP_PROJECT_NUMBER=529104096274 \
 *   GCP_WORKLOAD_IDENTITY_POOL_ID=carbon-contractors-pool \
 *   GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID=vercel \
 *   GCP_SERVICE_ACCOUNT_EMAIL=kms-signer-svc@... \
 *   npx tsx scripts/verify-kms-signer.ts
 *
 * For local runs outside Vercel, you'll typically authenticate via
 * `gcloud auth application-default login` instead of the WIF path.
 * This script uses the same code path as production — any misalignment
 * between WIF/ADC will surface here before test night.
 *
 * Exits 0 on success, 1 on any verification failure with a clear diff.
 */

import { keccak256, recoverAddress, type Address, type Hex } from "viem";

// Minimum env vars the KMS signer module will need at import time
// (config.ts requires these even if we won't exercise all of them)
const REQUIRED_STUBS: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub",
  SUPABASE_SERVICE_ROLE_KEY: "stub",
  NEXT_PUBLIC_ONCHAINKIT_API_KEY: "stub",
  NEXT_PUBLIC_BASE_NETWORK: "testnet",
  NEXT_PUBLIC_USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
for (const [k, v] of Object.entries(REQUIRED_STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

const REQUIRED_KMS_VARS = ["GCP_KMS_KEY_PATH"];
for (const name of REQUIRED_KMS_VARS) {
  if (!process.env[name]) {
    console.error(`ERROR: ${name} is required. Set it before running this script.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const sep = "─".repeat(72);
  console.log(sep);
  console.log("KMS Signer Verification — hits real GCP Cloud KMS");
  console.log(sep);
  console.log("Key path:", process.env.GCP_KMS_KEY_PATH);
  console.log("");

  const { createKmsAccount, getEthAddressFromKms, _resetKmsClients } =
    await import("../src/lib/contracts/kms-signer");

  // ── Step 1: Derive address from KMS public key ────────────────────────────
  console.log("[1/4] Fetching public key from KMS and deriving Ethereum address...");
  const derivedAddress: Address = await getEthAddressFromKms();
  console.log("");
  console.log("  DERIVED ADDRESS:", derivedAddress);
  console.log("  (Fund this on Sepolia: https://sepoliafaucet.com)");
  console.log("");

  // ── Step 2: Create KMS-backed account ─────────────────────────────────────
  console.log("[2/4] Creating viem KMS account...");
  _resetKmsClients(); // clear cache so we exercise full init path for the account
  const account = await createKmsAccount();
  if (account.address !== derivedAddress) {
    console.error("FAIL: account.address does not match getEthAddressFromKms()");
    console.error("  getEthAddressFromKms:", derivedAddress);
    console.error("  account.address:     ", account.address);
    process.exit(1);
  }
  console.log("  OK — account.address matches derived address");
  console.log("  nonceManager:", account.nonceManager ? "attached" : "MISSING");
  if (!account.nonceManager) {
    console.error("FAIL: nonceManager is not attached to the KMS account");
    process.exit(1);
  }
  console.log("");

  // ── Step 3: Sign a known message via KMS ──────────────────────────────────
  console.log("[3/4] Signing a known message via KMS asymmetricSign...");
  const testMessage = "kms-signer verification — " + new Date().toISOString();
  const signature = await account.signMessage({ message: testMessage });
  console.log("  Message:   ", testMessage);
  console.log("  Signature: ", signature);
  console.log("");

  // ── Step 4: Recover address and assert it matches ─────────────────────────
  console.log("[4/4] Recovering address from signature via viem.recoverAddress...");
  // viem's signMessage applies EIP-191 hashing internally; we compute the same
  // hash by importing hashMessage and feeding it to recoverAddress.
  const { hashMessage } = await import("viem");
  const messageHash: Hex = hashMessage(testMessage);
  const recovered: Address = await recoverAddress({
    hash: messageHash,
    signature,
  });
  console.log("  Recovered: ", recovered);
  console.log("  Derived:   ", derivedAddress);
  console.log("");

  if (recovered.toLowerCase() !== derivedAddress.toLowerCase()) {
    console.error(sep);
    console.error("FAIL: Recovered address does NOT match derived address");
    console.error(sep);
    console.error("  Derived:   ", derivedAddress);
    console.error("  Recovered: ", recovered);
    console.error("");
    console.error("This indicates a bug in one of:");
    console.error("  - PEM public-key parsing (last 65 bytes extraction)");
    console.error("  - keccak256 address derivation");
    console.error("  - DER -> r/s/v conversion");
    console.error("  - Low-S normalization");
    console.error("  - Recovery parameter (v) selection");
    console.error("Run the unit tests for kms-signer to narrow down.");
    process.exit(1);
  }

  // ── Basic keccak256 sanity check (independent of KMS) ─────────────────────
  const sanity = keccak256("0x");
  if (!sanity.startsWith("0x")) {
    console.error("FAIL: keccak256 sanity check failed — viem import broken?");
    process.exit(1);
  }

  console.log(sep);
  console.log("✓ ALL CHECKS PASSED");
  console.log(sep);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Fund ${derivedAddress} on Sepolia: https://sepoliafaucet.com`);
  console.log("  2. Deploy CarbonEscrow with KMS address as owner");
  console.log("  3. Deploy to a Vercel preview to verify the WIF path end-to-end");
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error("ERROR during verification:");
  console.error(err);
  process.exit(1);
});
