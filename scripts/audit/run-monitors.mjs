/**
 * run-monitors.mjs — the scheduling and alerting layer for CC-085 / ADR-0003.
 *
 * Runs every invariant monitor, reports the result, and makes the *absence* of a report
 * detectable. It is not a test framework and does not want to become one: it shells out to
 * the same plain .mjs scripts a human runs by hand, and its only opinions are about what
 * counts as a failure and where the failure gets sent.
 *
 * ## Alert on absence (ADR-0003 D3)
 *
 * The dominant failure mode after Amendment 1 is *nothing happened*. Conventional error
 * alerting cannot see that, so every invariant is a positive assertion checked on a
 * schedule — and the schedule itself has to be checkable, because a cron that stops
 * running produces exactly the same silence as a system with nothing wrong.
 *
 * Two independent paths, per ADR-0003 D5. They are independent in the specific sense that
 * matters: **neither one needs GitHub to be working.**
 *
 *   Path 1 — webhook (Discord / Telegram / Slack). Fires on failure. Tells you WHAT broke.
 *            Requires the workflow to have run, so it cannot report its own absence.
 *   Path 2 — dead-man's switch (a free external cron monitor: healthchecks.io, Cronitor,
 *            BetterStack). This run pings it ONLY when everything passed. The external
 *            service alerts when the ping does not arrive. That covers scheduled Actions
 *            being delayed under load, Actions being auto-disabled after 60 days of
 *            repository inactivity — which this repo has already experienced once, it was
 *            dormant May–July 2026 — and GitHub itself being the thing that failed.
 *
 * Path 2 is why success is not announced on the webhook by default. An hourly "all clear"
 * in a chat channel is read for a week and ignored forever after, and an alert channel
 * nobody reads is not an alert channel. Silence is the success signal; the dead-man's
 * switch is what turns silence into noise when it should not be silent. Set
 * MONITOR_HEARTBEAT_ON_SUCCESS=1 if you want the chatty version anyway.
 *
 * ## Alert delivery is itself monitored
 *
 * If the webhook POST fails, this exits non-zero and does NOT ping the heartbeat — so the
 * Actions run goes red and the external path fires. An alerting system that fails quietly
 * is worse than none, because it is trusted.
 *
 * ## What is NOT here
 *
 * No paid indexer (ADR-0003 D5, explicitly rejected at this volume — every monitor reads
 * the chain directly with bounded, chunked getLogs). No paid alerting vendor. No database.
 * No state carried between runs: each run recomputes from the chain, so a missed run
 * costs nothing and there is no store to corrupt.
 *
 *   node --env-file=.env.local scripts/audit/run-monitors.mjs
 *   node --env-file=.env.local scripts/audit/run-monitors.mjs --only=verify-signer
 *   node --env-file=.env.local scripts/audit/run-monitors.mjs --no-alert
 *   node scripts/audit/run-monitors.mjs --list      # offline: validates the registry
 *
 * Env: MONITOR_WEBHOOK_URL · MONITOR_WEBHOOK_STYLE (discord|slack|telegram|raw) ·
 *      MONITOR_TELEGRAM_CHAT_ID · MONITOR_HEARTBEAT_URL · MONITOR_HEARTBEAT_ON_SUCCESS
 *
 * URLs are treated as secrets and are never printed, not even partially — a Discord
 * webhook URL is a bearer credential and Actions logs for a public repo are public.
 *
 * Exit codes: 0 all green · 1 a monitor failed, or alert delivery failed · 2 the runner
 *             itself is misconfigured
 */

import { spawn } from "node:child_process";
import { verdictLine } from "./verdict-line.mjs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/**
 * The registry. `tier: "wake"` is ADR-0003's open item on alert routing — solvency and
 * signer failures are the ones that warrant waking someone up, because both are about
 * money moving wrongly rather than a number drifting.
 *
 * `requires` is checked before the script runs, so a monitor that cannot run reports SKIP
 * instead of a confusing exit 2. Skips are always printed and always included in the
 * alert body: a monitor that quietly stopped running is the exact failure ADR-0003 D3 is
 * about.
 */
const MONITORS = [
  {
    name: "verify-escrow-solvency",
    script: "verify-escrow-solvency.mjs",
    tier: "wake",
    invariant: "USDC.balanceOf(escrow) == totalLocked()",
    requires: ["NEXT_PUBLIC_ESCROW_CONTRACT", "NEXT_PUBLIC_USDC_ADDRESS"],
  },
  {
    name: "verify-contract-owner",
    script: "verify-contract-owner.mjs",
    tier: "wake",
    invariant: "the HSM key, not a raw local key, owns the escrow",
    requires: ["NEXT_PUBLIC_ESCROW_CONTRACT"],
  },
  {
    name: "verify-signer",
    script: "verify-signer.mjs",
    args: ["--no-kms"],
    tier: "wake",
    invariant: "the contract accepts this verdict signer, and the EIP-712 domain matches",
    requires: ["NEXT_PUBLIC_ESCROW_CONTRACT"],
    // --no-kms by default: the live KMS round trip needs an impersonated ADC session
    // (CC-059) which no scheduled runner currently holds. Checks 1-3 still run and still
    // catch the silent cases. Drop the flag wherever credentials exist — see the ticket.
    note: "runs without the live KMS round trip; see CC-085 for the credential gap",
  },
  {
    name: "verify-unclaimed",
    script: "verify-unclaimed.mjs",
    tier: "normal",
    invariant: "nothing claimable by a worker unclaimed for more than N days",
    requires: ["NEXT_PUBLIC_ESCROW_CONTRACT", "ESCROW_DEPLOY_BLOCK"],
  },
  {
    name: "verify-concurrent-escrow",
    script: "verify-concurrent-escrow.mjs",
    tier: "normal",
    invariant: "peak concurrent USDC per funding agent, against CC-051's exemption limbs",
    requires: ["NEXT_PUBLIC_ESCROW_CONTRACT", "ESCROW_DEPLOY_BLOCK"],
  },
  {
    name: "verify-checker",
    script: "verify-checker.mjs",
    exec: "tsx",
    tier: "normal",
    invariant:
      "the deterministic evidence checker returns the known-correct verdicts for the canary set (CC-083)",
    // Nothing required: fully offline by design — the one monitor that cannot fail for
    // infrastructure reasons, so any red here is the checker itself being wrong.
    requires: [],
  },
  {
    name: "verify-sanctions",
    script: "verify-sanctions.ts",
    exec: "tsx",
    tier: "normal",
    invariant:
      "no registered or in-flight wallet is on a sanctions list today (CC-099 re-screening)",
    // Anon access only, by design: humans and tasks_public are world-readable, so this
    // monitor holds no privileged credential. The workflow must supply the two public
    // Supabase values as secrets/vars or this SKIPs — visibly, never silently.
    requires: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
  },
];

/**
 * Deliberately NOT scheduled, and why — so the next reader does not "fix" the omission:
 *
 *   find-deploy-block.mjs      a one-shot lookup, not an invariant.
 *   probe-exec-sql.mjs         a probe, and it needs the service role key.
 *   verify-getlogs-recovery.mjs  asserts against a specific v1 transaction and is stale
 *                              since the CC-082 redeploy. It is CC-070 acceptance
 *                              evidence, not a live invariant.
 *
 * And the three monitors in CC-085's table that do not exist yet — verify-commitments,
 * verify-retention, verify-verdict-rate — are blocked on the CC-081 funding-path fix and
 * the ADR-0002 retention job. Adding a stub that always passes would be worse than their
 * absence, because it would read as coverage.
 */

// TRAN is a monitor that could not reach the chain after retries. It counts as a failure —
// an invariant that went unchecked is not a passing one, which is ADR-0003 D3's whole point
// — but it is labelled apart from CONF so the reader is not sent hunting for a config error
// that does not exist. That is what happened on 2026-08-17: an RPC blip reported as
// `misconfig`, which reads as "you set this up wrong".
const ICON = { PASS: "PASS", FAIL: "FAIL", MISCONFIG: "CONF", TRANSIENT: "TRAN", SKIP: "SKIP" };

/**
 * `exec: "tsx"` on a registry entry runs the script through the pinned tsx CLI rather
 * than bare node — for monitors whose subject is TypeScript under src/lib (verify-checker
 * and the checker it watches). Resolved to the exact file so it never depends on PATH or
 * npx, in a runner whose whole job is to behave identically everywhere it fires.
 */
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function runScript(script, args, exec) {
  return new Promise((resolve) => {
    const argv = exec === "tsx" ? [TSX_CLI, join(HERE, script)] : [join(HERE, script)];
    const child = spawn(process.execPath, [...argv, ...args], {
      cwd: REPO,
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => resolve({ code: 2, out: `${out}\nspawn failed: ${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// Lives in its own module so it can be unit-tested. It could not be while it was inline
// here — this file self-executes on import — and its untested fallback branch put a bare
// `Version: viem@2.55.10` into a real Discord alert on 2026-08-17.

async function postWebhook(body) {
  const url = process.env.MONITOR_WEBHOOK_URL;
  if (!url) return { attempted: false };

  // `||`, not `??`: an unset GitHub Actions variable arrives as the empty string, not as
  // undefined. With `??` that would silently select the generic payload shape and Discord
  // would reject every alert — an alerting path that fails only when it is needed.
  const style = (process.env.MONITOR_WEBHOOK_STYLE || "discord").toLowerCase();
  let payload;
  if (style === "discord") payload = { content: body.slice(0, 1900) };
  else if (style === "slack") payload = { text: body.slice(0, 3000) };
  else if (style === "telegram") {
    const chatId = process.env.MONITOR_TELEGRAM_CHAT_ID;
    if (!chatId) return { attempted: true, ok: false, detail: "MONITOR_TELEGRAM_CHAT_ID is unset" };
    payload = { chat_id: chatId, text: body.slice(0, 4000), disable_web_page_preview: true };
  } else payload = { text: body.slice(0, 4000) };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    // Never echo the URL — a webhook URL is a bearer credential and this repo is public.
    return { attempted: true, ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { attempted: true, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function pingHeartbeat(path) {
  const base = process.env.MONITOR_HEARTBEAT_URL;
  if (!base) return { attempted: false };
  const url = path ? `${base.replace(/\/$/, "")}/${path}` : base;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15_000) });
    return { attempted: true, ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { attempted: true, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function runContext() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const noAlert = args.includes("--no-alert");
  const strict = args.includes("--strict");
  const onlyRaw = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()) : null;

  // ── --args: extra flags appended to every selected monitor ────────────────
  //
  // Exists so the alerting path can be exercised on demand. An alerting path nobody has
  // watched fire is not a path you can rely on, and waiting for a genuine incident to
  // find out whether the webhook works is the wrong time to learn it does not.
  //
  // Deliberately generic rather than a per-monitor threshold flag. Which monitor can be
  // driven into failure depends on what is on chain at the time: with a task in flight,
  // `verify-unclaimed --max-age-days=0.001` breaches; against a settled escrow it cannot,
  // because there are no Delivered tasks at any threshold, and `verify-concurrent-escrow
  // --annual-limit=1` is the one that still bites since it replays historical volume.
  // Hard-coding either would have produced a drill that silently stops working.
  //
  // Safe on the schedule by construction: a scheduled run supplies no workflow inputs, so
  // this is always empty there. It cannot arm itself.
  const argsRaw = args.find((a) => a.startsWith("--args="))?.slice("--args=".length);
  const extraArgs = argsRaw ? argsRaw.trim().split(/\s+/).filter(Boolean) : [];
  const isDrill = extraArgs.length > 0;

  if (only) {
    const unknown = only.filter((n) => !MONITORS.some((m) => m.name === n));
    if (unknown.length > 0) {
      console.error(`MISCONFIGURED: unknown monitor(s): ${unknown.join(", ")}`);
      console.error(`Known: ${MONITORS.map((m) => m.name).join(", ")}`);
      return 2;
    }
  }

  const selected = MONITORS.filter((m) => !only || only.includes(m.name));

  // ── --list: offline registry validation, safe for CI ──────────────────────
  if (listOnly) {
    console.log("Invariant monitors (CC-085 / ADR-0003 D2)");
    console.log("");
    let missing = 0;
    for (const m of MONITORS) {
      const path = join(HERE, m.script);
      const ok = existsSync(path);
      if (!ok) missing++;
      console.log(`  ${ok ? "  " : "!!"} ${m.name.padEnd(26)} ${m.tier.padEnd(7)} ${m.script}${ok ? "" : "  MISSING"}`);
      console.log(`     ${m.invariant}`);
      console.log(`     requires: ${m.requires.join(", ")}`);
      if (m.note) console.log(`     note: ${m.note}`);
    }
    console.log("");
    if (missing > 0) {
      console.error(`${missing} registered monitor script(s) do not exist. The schedule would`);
      console.error("silently stop checking them — which is the failure mode this ticket exists");
      console.error("to prevent. Fix the registry or restore the script.");
      return 1;
    }
    console.log(`${MONITORS.length} monitor(s), all present.`);
    return 0;
  }

  const started = new Date();
  console.log("── Invariant monitors ───────────────────────────────────────────");
  console.log(`started   ${started.toISOString()}`);
  console.log(`monitors  ${selected.map((m) => m.name).join(", ")}`);
  console.log("");

  const results = [];
  for (const m of selected) {
    const missing = m.requires.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      results.push({ ...m, status: "SKIP", verdict: `missing env: ${missing.join(", ")}`, code: null });
      console.log(`${ICON.SKIP}  ${m.name} — missing env: ${missing.join(", ")}`);
      continue;
    }

    const t0 = Date.now();
    const { code, out } = await runScript(m.script, [...(m.args ?? []), ...extraArgs], m.exec);
    const status =
      code === 0 ? "PASS" : code === 2 ? "MISCONFIG" : code === 3 ? "TRANSIENT" : "FAIL";
    const verdict = verdictLine(out);
    results.push({ ...m, status, verdict, code });

    console.log(`${ICON[status]}  ${m.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${verdict}`);
    if (status !== "PASS") {
      // Full output only for the ones that matter — a passing monitor's output is noise,
      // and Actions logs on a public repo are public.
      console.log("");
      console.log(out.trimEnd().split("\n").map((l) => `    | ${l}`).join("\n"));
      console.log("");
    }
  }

  const failed = results.filter(
    (r) => r.status === "FAIL" || r.status === "MISCONFIG" || r.status === "TRANSIENT",
  );
  const skipped = results.filter((r) => r.status === "SKIP");
  const wake = failed.filter((r) => r.tier === "wake");
  const green = failed.length === 0 && (!strict || skipped.length === 0);

  console.log("");
  console.log(
    `summary   ${results.filter((r) => r.status === "PASS").length} pass · ${failed.length} fail · ${skipped.length} skip`,
  );

  // ── Build the alert body ──────────────────────────────────────────────────
  const ctx = runContext();
  const lines = [];
  // A drill must never be mistakeable for an incident. If someone fires this to test the
  // webhook and the message looks identical to a real failure, the next genuine alert is
  // one someone has already been trained to ignore — which is worse than no alert at all.
  if (isDrill) {
    lines.push("🧪 **DRILL — NOT A REAL FAILURE.** Monitor thresholds were overridden by hand.");
    lines.push(`overrides: ${extraArgs.join(" ")}`);
  }
  lines.push(
    green
      ? `Carbon Contractors invariant monitors: all clear (${results.length} checked)`
      : `Carbon Contractors INVARIANT FAILURE — ${failed.length} of ${results.length}${wake.length > 0 ? " (includes a wake-someone-up tier)" : ""}`,
  );
  lines.push(`network ${process.env.NEXT_PUBLIC_BASE_NETWORK || "testnet"} · ${started.toISOString()}`);
  for (const r of results) {
    lines.push(`${r.status === "PASS" ? "ok" : r.status.toLowerCase()} · ${r.name} · ${r.verdict}`);
  }
  if (!green) {
    lines.push("");
    lines.push(
      "First response is to PAUSE NEW TASK CREATION, not to debug (ADR-0003 D4). Tasks already " +
        "in flight resolve safely on their own clocks; new ones would not. Never pause claims — " +
        "halting settlement mid-flight strands funds and inverts ADR-0001 D6.",
    );
  }
  if (ctx) lines.push(ctx);
  const body = lines.join("\n");

  // ── Deliver ───────────────────────────────────────────────────────────────
  let deliveryFailed = false;

  if (noAlert) {
    console.log("alerting  suppressed (--no-alert)");
  } else {
    const wantWebhook = !green || process.env.MONITOR_HEARTBEAT_ON_SUCCESS === "1";
    if (wantWebhook) {
      const res = await postWebhook(body);
      if (!res.attempted) {
        console.log("alerting  MONITOR_WEBHOOK_URL is unset — path 1 is not configured");
        if (!green) deliveryFailed = true;
      } else if (res.ok) {
        console.log(`alerting  webhook delivered (${res.detail})`);
      } else {
        console.log(`alerting  WEBHOOK DELIVERY FAILED (${res.detail})`);
        deliveryFailed = true;
      }
    } else {
      console.log("alerting  all clear — no webhook post (set MONITOR_HEARTBEAT_ON_SUCCESS=1 to change)");
    }

    // Dead-man's switch. Only pinged on a fully green run: the external service's own
    // "no ping in N minutes" alarm is path 2, and it must fire when this run does not
    // happen at all, not merely when it happens and fails.
    //
    // A drill deliberately does NOT touch it. The heartbeat's whole job is to record
    // whether the monitors are genuinely running and genuinely passing; marking it down
    // because someone tested the webhook makes its own history lie, and the history is
    // the only thing that distinguishes "the schedule stopped" from "everything is fine".
    // Drills exercise path 1. Path 2 proves itself on every real green run.
    const hb = isDrill
      ? { attempted: false, drill: true }
      : await pingHeartbeat(green ? "" : "fail");
    if (isDrill) {
      console.log("alerting  heartbeat skipped — drill runs must not mark the dead-man's switch down");
    } else if (!hb.attempted) {
      console.log("alerting  MONITOR_HEARTBEAT_URL is unset — PATH 2 IS NOT CONFIGURED.");
      console.log("          Scheduled Actions are best-effort and are auto-disabled after 60 days");
      console.log("          of repository inactivity. Without a dead-man's switch, this monitor");
      console.log("          silently ceasing to run is indistinguishable from everything passing.");
    } else if (hb.ok) {
      console.log(`alerting  heartbeat ${green ? "ping" : "/fail"} delivered (${hb.detail})`);
    } else {
      console.log(`alerting  HEARTBEAT DELIVERY FAILED (${hb.detail})`);
      deliveryFailed = true;
    }
  }

  console.log("");
  if (green && !deliveryFailed) {
    console.log(
      skipped.length === 0
        ? "ALL CLEAR"
        : `ALL CLEAR on what ran — but ${skipped.length} monitor(s) were SKIPPED and checked nothing. ` +
            "Use --strict to make that fatal.",
    );
    return 0;
  }
  if (deliveryFailed) {
    console.log("Alert delivery failed. Treated as a failure on purpose: an alerting path that");
    console.log("breaks quietly is worse than no alerting, because it is trusted.");
  }
  if (failed.length === 0 && skipped.length > 0 && strict) {
    console.log(`FAILED under --strict: ${skipped.length} monitor(s) could not run, so ${skipped.length}`);
    console.log("invariant(s) went unchecked. Under --strict that is a failure rather than a");
    console.log("footnote, because an unchecked invariant and a passing one look identical.");
  }
  return 1;
}

process.exitCode = await main();
