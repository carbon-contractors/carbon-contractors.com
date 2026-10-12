/**
 * admin/transfer-escrow-ownership.ts
 *
 * CC-059 — transfers ownership of CarbonEscrow from the
 * raw local deployer key to the GCP KMS/HSM-derived signing address.
 *
 * TWO TRANSACTIONS, TWO KEYS (NOR-537). The contract is Ownable2Step, so
 * transferOwnership() no longer moves anything: it NOMINATES. It sets pendingOwner()
 * and owner() stays the deployer until the nominee itself calls acceptOwnership().
 * This script sends the nomination with the deployer key, then prints the acceptance
 * and stops with PENDING. It does not send the acceptance for any target:
 *
 *   - the HSM target signs through the KMS signer, which is app code
 *     (src/lib/contracts/signer.ts). Hardhat can load it at runtime, but
 *     tsconfig.hardhat.json cannot typecheck it, and it validates the app's whole env
 *     schema, which the Hardhat world deliberately does not use (see hardhat.config.ts).
 *     So the acceptance lives in verify-escrow-lifecycle.ts as `accept-ownership`,
 *     next to the other owner transaction that script already sends with the KMS key;
 *   - any other target (the 2-of-4 Safe, CC-090) signs with its own keys.
 *
 * Ownable2Step removes the failure this header used to warn about. A target that
 * cannot sign can never accept, so the contract can no longer be sent to a dead key,
 * and a mistyped nomination is undone by nominating again. The ACCEPTANCE is the
 * one-way step: once it lands, the local DEPLOYER_PRIVATE_KEY can no longer arbitrate
 * disputes. Still run `npm run verify:kms` before accepting with the KMS key — see
 * CC-059's "Fix" section.
 *
 * Until the acceptance lands the deployer is still the owner, and the owner cannot
 * be a party to a task (NOR-537 F1), so the deployer cannot fund one either.
 *
 * Usage:
 *   npx hardhat run scripts/admin/transfer-escrow-ownership.ts --network baseSepolia
 *     -> dry run: reads owner() and pendingOwner(), derives the HSM address, prints
 *        what WOULD happen. Sends no transactions.
 *
 *   CONFIRM=true npx hardhat run scripts/admin/transfer-escrow-ownership.ts --network baseSepolia
 *     -> calls transferOwnership(), confirms pendingOwner(), prints the
 *        acceptOwnership() call the target must make. Exits 0 with PENDING.
 *
 *   Re-run it after the acceptance: it reports OK once owner() reads the target.
 *   Re-running before then is safe. A target already in pendingOwner() is not
 *   nominated again.
 *
 * (Hardhat 3's `run` task validates CLI arguments strictly against its own
 * defined parameters and rejects anything else — the Hardhat 2-era
 * `-- --flag` passthrough to the script's own argv no longer works, hence the
 * env var instead.)
 *
 * Requires in .env.local:
 *   DEPLOYER_PRIVATE_KEY=0x...        (must be the CURRENT owner of the escrow)
 *   NEXT_PUBLIC_ESCROW_CONTRACT=0x...
 * Optional:
 *   NEW_OWNER=0x...                   (default: the HSM address derived from the .pub)
 */

import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The subset of the HRE-injected ethers namespace this script needs. */
interface EthersLike {
  keccak256(data: string): string;
  getAddress(address: string): string;
  getSigners(): Promise<Array<{ address: string }>>;
  // ethers hands back an untyped `Contract` — hardhat-typechain is configured but emits
  // nothing under Hardhat 3, so contract methods resolve at runtime through its proxy.
  // This used to declare `{ owner(); transferOwnership() }`, which read as safer but was
  // never actually checked: the file was excluded from every tsconfig until CC-082 added
  // one that covers it, and the declaration does not match what ethers returns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContractAt(name: string, address: string): Promise<any>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUB_KEY_PATH = join(__dirname, "..", "..", "docs", "carbon-contractors-escrow-signer-1.pub");

/**
 * Derive an Ethereum address from a secp256k1 SubjectPublicKeyInfo PEM.
 * The uncompressed EC point (0x04 || x || y) is always the last 65 bytes of the
 * DER. Mirrors scripts/audit/verify-contract-owner.mjs and
 * getEthAddressFromKms() in src/lib/contracts/kms-signer.ts — kept as a
 * derivation, not a hardcoded literal, so a typo can't silently send
 * ownership somewhere wrong.
 */
function addressFromPem(path: string, ethers: EthersLike): string {
  const body = readFileSync(path, "utf8")
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error(`Expected uncompressed EC point (0x04 prefix), got 0x${point[0].toString(16)}`);
  }
  const hash = ethers.keccak256("0x" + Buffer.from(point.subarray(1)).toString("hex"));
  return ethers.getAddress("0x" + hash.slice(-40));
}

const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_CONTRACT;

if (!ESCROW_ADDRESS) throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT must be set in .env.local");

const CONFIRM = process.env.CONFIRM === "true";

// Blank is unset (CC-097): a bare `NEW_OWNER=` line must fall back to the HSM key, not
// reach getAddress("") and abort, or worse, be read as a target.
const NEW_OWNER = process.env.NEW_OWNER?.trim() || null;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface TransferResult {
  name: string;
  ok: boolean;
  skipped: boolean;
  dryRun: boolean;
  /** Nominated, but owner() has not moved: the target has not called acceptOwnership(). */
  pending: boolean;
}

async function transferOne(
  ethers: EthersLike,
  contractName: "CarbonEscrow",
  address: string,
  newOwner: string,
  hsmAddress: string,
  deployerAddress: string,
): Promise<TransferResult> {
  const result = { name: contractName, ok: true, skipped: false, dryRun: false, pending: false };
  const failed = { ...result, ok: false };

  console.log(`\n── ${contractName} @ ${address}`);
  const contract = await ethers.getContractAt(contractName, address);
  const currentOwner: string = await contract.owner();
  console.log(`   current owner: ${currentOwner}`);

  if (same(currentOwner, newOwner)) {
    console.log("   already owned by the target — nothing to do.");
    // A nomination left dangling after the transfer completed could still be accepted by
    // its nominee. verify-escrow-deployment.mjs fails on it; say so here too rather than
    // report a clean OK. Best-effort: a pre-NOR-537 deployment has no pendingOwner().
    try {
      const dangling: string = await contract.pendingOwner();
      if (!/^0x0{40}$/i.test(dangling)) {
        console.log(`   WARNING: pendingOwner() is ${dangling}. That address can still accept ownership.`);
      }
    } catch {
      // Single-step Ownable: nothing can be pending.
    }
    return { ...result, skipped: true };
  }

  // pendingOwner() exists from NOR-537 (Ownable2Step) on. A throw here is either a
  // deployment that predates it or a node that has not seen a fresh deploy's code yet,
  // and this script cannot tell which, so it says both and stops.
  let pendingOwner: string;
  try {
    pendingOwner = await contract.pendingOwner();
  } catch {
    console.log("   ABORT: could not read pendingOwner(). Either this deployment predates");
    console.log("   Ownable2Step (NOR-537), or the RPC has not caught up with a fresh deploy.");
    console.log("   Check before re-running:");
    console.log("     node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs");
    return failed;
  }
  console.log(`   pending owner: ${pendingOwner}`);

  if (same(pendingOwner, newOwner)) {
    console.log("   already nominated — skipping transferOwnership(); only the acceptance is left.");
    printAcceptance(contract, address, newOwner, hsmAddress);
    return { ...result, pending: true };
  }

  if (!same(currentOwner, deployerAddress)) {
    console.log(
      `   ABORT: deployer (${deployerAddress}) is not the current owner. Refusing to proceed.`,
    );
    return failed;
  }

  if (!/^0x0{40}$/i.test(pendingOwner)) {
    console.log("   NOTE: an earlier nomination is outstanding. Nominating the target replaces it.");
  }

  if (!CONFIRM) {
    console.log(
      `   DRY RUN — would call transferOwnership(${newOwner}), which only nominates it.`,
    );
    console.log("   Re-run with CONFIRM=true to execute; the acceptance is printed after that.");
    return { ...result, dryRun: true };
  }

  console.log(`   Calling transferOwnership(${newOwner})...`);
  const tx = await contract.transferOwnership(newOwner);
  console.log(`   tx: ${tx.hash} — waiting for confirmation...`);
  await tx.wait();

  // This confirmation read is what Lessons-Learned §16 is about. It ran once, immediately
  // after tx.wait(), against a load-balanced public gateway with no read-your-writes
  // guarantee — hit a backend that had not caught up, returned the OLD owner, and printed
  // a confident `FAILED` for two transfers that had both succeeded.
  //
  // §16 was written on 2026-08-08 and the script was not changed. On 2026-08-15 it did the
  // exact same thing to the CC-082 redeploy. Recording a lesson is not fixing it.
  //
  // So: poll rather than read once, and — more importantly — distinguish "confirmed it did
  // not happen" from "could not confirm". Those are different results and only one of them
  // means the transfer failed.
  //
  // Under Ownable2Step (NOR-537) the value to poll is pendingOwner(), not owner().
  // owner() is SUPPOSED to still read the deployer at this point, so polling it would time
  // out on every correct run and print COULD NOT CONFIRM. That would make §16's false
  // negative permanent.
  const confirmedPending = await pollForPendingOwner(contract, newOwner);

  if (confirmedPending && same(confirmedPending, newOwner)) {
    console.log(`   pending owner: ${confirmedPending} — nominated`);
    printAcceptance(contract, address, newOwner, hsmAddress);
    return { ...result, pending: true };
  }

  console.log(`   last read: ${confirmedPending ?? "unreadable"} — COULD NOT CONFIRM`);
  console.log(`   The transaction was mined. This is very likely RPC lag, not a failure.`);
  console.log(`   Re-running is safe: an existing nomination is detected and not re-sent.`);
  console.log(`   Verify independently before concluding anything:`);
  console.log(`     node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs`);
  console.log(`     https://sepolia.basescan.org/tx/${tx.hash}`);
  return failed;
}

/**
 * The second half of the transfer. owner() has NOT moved when this prints, and the call
 * must come from the target itself: acceptOwnership() takes no argument and checks
 * msg.sender against pendingOwner().
 */
function printAcceptance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: any,
  escrow: string,
  target: string,
  hsmAddress: string,
): void {
  const data: string = contract.interface.encodeFunctionData("acceptOwnership");
  console.log("\n   PENDING — owner() has not moved. The target must accept, from its own key:");
  console.log(`     to:    ${escrow}`);
  console.log(`     from:  ${target}`);
  console.log(`     call:  acceptOwnership()   data: ${data}   value: 0`);
  if (same(target, hsmAddress)) {
    console.log("\n   The target is the KMS/HSM key, which this script cannot sign with. Accept");
    console.log("   through the lifecycle tooling (Base Sepolia). Dry run first, then CONFIRM=true:");
    console.log("     node --env-file=.env.local node_modules/tsx/dist/cli.mjs \\");
    console.log("       scripts/admin/verify-escrow-lifecycle.ts accept-ownership");
  } else {
    console.log("\n   For a Safe: one transaction to the escrow with the data above, value 0,");
    console.log("   proposed and signed to threshold through the Safe itself.");
  }
  const ownerFlag = same(target, hsmAddress) ? "" : ` --owner=${target}`;
  console.log("\n   Then re-run this script (OK once owner() reads the target), and confirm");
  console.log("   pendingOwner() is back to zero:");
  console.log(`     node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs${ownerFlag}`);
}

/**
 * Re-reads pendingOwner() until it reports the expected address, or attempts run out.
 *
 * Polls for the value we expect rather than retrying on exception, because the failure mode
 * here is not an error — it is a *successful* read returning stale data. A generic
 * try/catch retry would have caught nothing on 2026-08-08 or 2026-08-15.
 */
async function pollForPendingOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: any,
  expected: string,
  attempts = 8,
): Promise<string | null> {
  let last: string | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = (await contract.pendingOwner()) as string;
      if (same(last, expected)) return last;
    } catch {
      // A codeless-address read on a lagging node throws rather than returning stale data.
      last = null;
    }
    if (i < attempts) {
      console.log(`   pendingOwner() not updated yet, re-reading in 5s (${i}/${attempts - 1})...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return last;
}

async function main() {
  // No network/chainType args: connects using whatever --network was passed
  // on the CLI (baseSepolia or base), matching the existing deploy scripts'
  // convention.
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const hsmAddress = addressFromPem(PUB_KEY_PATH, ethers);
  console.log(
    "HSM/KMS address (derived from docs/carbon-contractors-escrow-signer-1.pub):",
    hsmAddress,
  );

  // NEW_OWNER names another target: the 2-of-4 Safe (CC-090). getAddress rejects a bad
  // checksum. A wrong but valid address can no longer lose the contract, because a nominee
  // that cannot sign can never accept.
  const target = NEW_OWNER ? ethers.getAddress(NEW_OWNER) : hsmAddress;
  console.log(
    "Target owner:",
    target,
    !NEW_OWNER ? "(the HSM key)" : same(target, hsmAddress) ? "(NEW_OWNER — the HSM key)" : "(NEW_OWNER — NOT the HSM key)",
  );

  console.log(
    CONFIRM
      ? "\n*** LIVE RUN — this will send on-chain transactions. ***"
      : "\n*** DRY RUN — no transactions will be sent. Set CONFIRM=true to execute. ***",
  );

  const escrowResult = await transferOne(
    ethers,
    "CarbonEscrow",
    // Non-null: checked above.
    ESCROW_ADDRESS as string,
    target,
    hsmAddress,
    deployer.address,
  );

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  for (const r of [escrowResult]) {
    const status = !r.ok ? "FAILED" : r.pending ? "PENDING — nominated, awaiting acceptOwnership()" : "OK";
    const suffix = r.skipped ? " (already transferred)" : r.dryRun ? " (dry run)" : "";
    console.log(`  ${r.name}: ${status}${suffix}`);
  }

  // PENDING exits 0. It is the correct end state for this script, not a failure: the
  // second transaction belongs to a different key.
  if (!escrowResult.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
