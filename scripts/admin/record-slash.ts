/**
 * record-slash.ts — write the resolution-time record for a stake slash
 * (NOR-330, migration 023).
 *
 * The chain's Slashed event says a worker was slashed and by how much, but not
 * which dispute caused it — that knowledge exists only in the room where the
 * owner resolves. This script is how it gets written down before it walks out
 * of the room: run it right after the on-chain slash, with the tx hash and the
 * disputed task's payment_request_id.
 *
 * The row is an attestation by the platform, anchored by the tx_hash (unique —
 * re-running with the same hash is a no-op conflict, not a duplicate). Anyone
 * can verify the recorded amount against the Slashed event the hash points at.
 *
 * Usage:
 *   node --env-file=.env.local npx tsx scripts/admin/record-slash.ts \
 *     --wallet 0x... --amount-usdc 5 --task <payment_request_id> --tx-hash 0x...
 *
 *   --task is optional: a slash without a task link records with a null task,
 *   which the dashboard renders as "task not recorded" rather than hiding.
 */

import { createSlashRecord } from "@/lib/db/slashes";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const wallet = arg("wallet");
  const amountRaw = arg("amount-usdc");
  const task = arg("task");
  const txHash = arg("tx-hash");

  if (!wallet || !amountRaw || !txHash) {
    console.error(
      "Usage: record-slash.ts --wallet 0x... --amount-usdc N [--task <payment_request_id>] --tx-hash 0x...",
    );
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    console.error("--wallet must be a 40-hex address");
    process.exit(1);
  }
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("--amount-usdc must be a positive number");
    process.exit(1);
  }

  const record = await createSlashRecord({
    wallet,
    amount_usdc: amount,
    payment_request_id: task ?? null,
    tx_hash: txHash,
  });

  console.log(
    `Recorded slash: ${record.amount_usdc} USDC against ${record.wallet}` +
      (record.payment_request_id ? ` for task ${record.payment_request_id}` : " (no task link)") +
      `\ntx: ${record.tx_hash}`,
  );
}

main().catch((err: unknown) => {
  // A 23505 here means this tx_hash is already recorded — that is a no-op,
  // not a failure. Anything else is real and should be loud.
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("(23505)")) {
    console.log("Already recorded for this tx hash — nothing to do.");
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
});
