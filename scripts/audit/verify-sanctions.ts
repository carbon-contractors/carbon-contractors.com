/**
 * verify-sanctions.ts — READ-ONLY re-screening monitor. CC-099 / CC-085 / ADR-0003 D2.
 *
 * Invariant: no wallet that has already entered the platform — registered worker or
 * party to a task — is on a sanctions list *today*.
 *
 * Registration and request_human_work screen at the door (CC-099), but lists move:
 * a wallet clean at registration can be designated later. That is what this monitor
 * catches, and it is why it re-screens everything rather than trusting the door.
 *
 * Per the ticket's blocking-vs-monitoring split, a hit here ALERTS and does nothing
 * else. Unwinding funds already locked for a later-listed wallet is an asset-freezing
 * question, not an engineering one — flagged to CC-098's legal review, never automated
 * by a monitor's discretion.
 *
 * Reads with the ANON key on purpose: `humans` is world-readable (it is the
 * whitepages) and `tasks_public` exposes both party wallets by design, so re-screening
 * needs no privileged access and this script never holds the service role.
 *
 * A canary case runs first: the bundled dataset's own entry must screen as sanctioned.
 * Without it, "no matches" is indistinguishable from "screening silently does
 * nothing" — the exact failure shape ADR-0003 D3 exists to prevent. The canary is
 * expected to hit and does NOT count as a finding.
 *
 * Limitation, stated: with CHAINALYSIS_API_KEY set and the provider down,
 * isWalletSanctioned fails open, so this run reports dataset-only results. The
 * fail-open path logs `sanctions_provider_api_error` — visible in the run output
 * below, which is why this script does not swallow the module's log lines.
 *
 *   node --env-file=.env.local scripts/audit/verify-sanctions.ts
 *   node scripts/audit/run-monitors.mjs --only=verify-sanctions
 *
 * Exit codes: 0 no matches (canary passed) · 1 a match, or the canary failed · 2 misconfig
 */

import { createClient } from "@supabase/supabase-js";
import { isWalletSanctioned } from "../../src/lib/sanctions";
import { SANCTIONED_ADDRESSES } from "../../src/lib/sanctions/data";

function maskWallet(address: string): string {
  return address.length < 10 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Actions logs on a public repo are public — workers' wallets are printed masked. */
function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  fail("MISCONFIGURED: SUPABASE_URL and SUPABASE_ANON_KEY are required (anon access is sufficient)");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── 1. Canary: the screening pipeline must actually screen ────────────────────
const canary = SANCTIONED_ADDRESSES[0];
const canaryResult = await isWalletSanctioned(canary.address);
if (!canaryResult.sanctioned) {
  console.error(
    `FAIL: canary — the bundled dataset entry ${maskWallet(canary.address)} did not screen as sanctioned. ` +
      "Every 'no match' below is unreliable: screening is silently doing nothing.",
  );
  process.exit(1);
}
console.log(`canary ok — dataset entry ${maskWallet(canary.address)} screens as sanctioned (${canaryResult.list})`);

// ── 2. Collect every wallet the platform has already admitted ─────────────────
const wallets = new Map<string, string>(); // lowercase address -> where it was seen

{
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("humans")
      .select("wallet")
      .order("wallet")
      .range(from, from + 999);
    if (error) fail(`MISCONFIGURED: humans unreadable via anon: ${error.message}`);
    for (const row of (data ?? []) as { wallet: string }[]) {
      wallets.set(row.wallet.toLowerCase(), "whitepages");
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
}

{
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("tasks_public")
      .select("from_agent_wallet,to_human_wallet")
      .order("payment_request_id")
      .range(from, from + 999);
    if (error) fail(`MISCONFIGURED: tasks_public unreadable via anon: ${error.message}`);
    for (const row of (data ?? []) as {
      from_agent_wallet: string | null;
      to_human_wallet: string | null;
    }[]) {
      if (row.from_agent_wallet)
        wallets.set(row.from_agent_wallet.toLowerCase(), "task agent");
      if (row.to_human_wallet) wallets.set(row.to_human_wallet.toLowerCase(), "task worker");
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
}

console.log(`screening ${wallets.size} distinct wallet(s) — humans + tasks_public, both parties`);

// ── 3. Re-screen ───────────────────────────────────────────────────────────────
const hits: { wallet: string; list?: string; reason?: string; seenAs: string }[] = [];
for (const [wallet, seenAs] of wallets) {
  const result = await isWalletSanctioned(wallet);
  if (result.sanctioned) {
    hits.push({ wallet: maskWallet(wallet), list: result.list, reason: result.reason, seenAs });
  }
}

if (hits.length > 0) {
  console.error(`FAIL: ${hits.length} sanctioned wallet match(es) already inside the platform:`);
  for (const h of hits) {
    console.error(`  ${h.wallet}  seen as: ${h.seenAs}  list: ${h.list ?? "?"}  reason: ${h.reason ?? "?"}`);
  }
  console.error("Do NOT auto-freeze in-flight funds — that call belongs to CC-098's legal review.");
  console.error("Block new participation for these wallets (CC-086 kill-switch shape) pending review.");
  process.exit(1);
}

console.log(
  `PASS — 0 sanctioned wallet matches across ${wallets.size} screened. ` +
    `Provider layer: ${process.env.CHAINALYSIS_API_KEY ? "chainalysis active" : "dataset only (no CHAINALYSIS_API_KEY)"}.`,
);
process.exit(0);
