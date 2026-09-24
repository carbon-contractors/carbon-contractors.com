/**
 * verify-uptime.mjs — READ-ONLY. CC-040, ADR-0003 handover step 6.
 *
 * Invariant: the production site is up, and /api/health says every subsystem it checks
 * is healthy — database, escrow contract, sessions — while reporting the escrow this
 * repo expects it to be talking to.
 *
 * This is the "external uptime monitor against /api/health" ADR-0003 D5 names, built as
 * a scheduled getLogs-free sibling of the invariant monitors rather than a third-party
 * SaaS account. It runs from GitHub Actions on the same hourly schedule, so it is NOT
 * independent of GitHub — which is why the ticket ALSO asks for a free external monitor
 * independent of both (healthchecks.io / UptimeRobot / BetterStack), wired to the
 * dead-man's switch heartbeat. That account is a PO action item (CC-111): the runner
 * already pings MONITOR_HEARTBEAT_URL on green; an external uptime checker watching
 * the production URL is the surviving path when GitHub is the thing that failed.
 *
 * ## Why the escrow identity check lives here
 *
 * /api/health reports *which* escrow it is reading — added after the CC-082 redeploy,
 * when there was no way from outside to tell whether production had picked up the new
 * contract. This monitor pins it: if production answers healthy against any escrow
 * other than EXPECTED_ESCROW (default NEXT_PUBLIC_ESCROW_CONTRACT), that is a MISCONFIG
 * (exit 2), not a FAIL — the site is up, but the deployment is answering from the wrong
 * configuration. See the health route's own comment: "pointed at the wrong escrow" is
 * exactly the ADR-0003 failure class where nothing errors and everything reports
 * healthy.
 *
 * ## Exit-code conventions
 *
 * 0 pass · 1 unhealthy (a check failed — availability) · 2 misconfigured (wrong escrow,
 * unparsable body) · 3 transient (network unreachable after retries)
 */

import { withRpcRetry, isTransient } from "./rpc-retry.mjs";

const TIMEOUT_MS = Number(process.env.MONITOR_UPTIME_TIMEOUT_MS ?? 20_000);

const url = process.env.UPTIME_TARGET_URL || "https://www.carbon-contractors.com/api/health";
const expectedEscrow = (
  process.env.EXPECTED_ESCROW ||
  process.env.NEXT_PUBLIC_ESCROW_CONTRACT ||
  ""
).toLowerCase();

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Env: UPTIME_TARGET_URL · EXPECTED_ESCROW (or NEXT_PUBLIC_ESCROW_CONTRACT)");
  console.log("     MONITOR_UPTIME_TIMEOUT_MS (default 20000)");
  process.exit(0);
}

function out(code, ...lines) {
  for (const l of lines) console.log(l);
  return code;
}

/** Header block, run under withRpcRetry so a blip retries instead of paging. */
function header() {
  console.log("── Uptime monitor (CC-040) ──────────────────────────────");
  console.log(`target  ${url}`);
  console.log(`expect  escrow ${expectedEscrow || "(any — EXPECTED_ESCROW unset)"}`);
  console.log("");
}

async function main() {
  if (!expectedEscrow) {
    return out(
      2,
      "MISCONFIGURED — EXPECTED_ESCROW (or NEXT_PUBLIC_ESCROW_CONTRACT) is unset.",
      "Without a pinned escrow this monitor only proves a URL answers, which is the",
      "vacuous check the health route's identity fields were added to prevent.",
    );
  }

  header();

  let res;
  try {
    res = await withRpcRetry("uptime fetch", () =>
      fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // A monitor traversing the CDN should not be served a stale edge cache of a
        // health response baked minutes ago; the health route is dynamic.
        cache: "no-store",
      }),
    );
  } catch (err) {
    if (isTransient(err)) {
      return out(
        3,
        `TRANSIENT — production unreachable after retries: ${shortErr(err)}`,
        "This is a network path problem, not a verdict on the site. If it repeats on",
        "consecutive runs, treat the site as unverified and check the Vercel status.",
      );
    }
    return out(2, `MISCONFIGURED — fetch failed outright: ${shortErr(err)}`);
  }

  if (res.status === 503) {
    // The health route's own failure polarity: 503 means it ran and found something
    // unhealthy. Parse the body so the alert says WHICH subsystem.
    let which = "(body unparsable)";
    try {
      const j = await res.json();
      which = Object.entries(j.checks ?? {})
        .filter(([, c]) => !c.ok)
        .map(([k, c]) => `${k}: ${c.error ?? "unhealthy"}`)
        .join("; ") || "ok-in-body-but-503";
    } catch {}
    return out(
      1,
      `FAIL — /api/health returned 503. Unhealthy: ${which}`,
      "The site is up enough to answer; a subsystem is not. See the runbook §Uptime.",
    );
  }

  if (res.status !== 200) {
    // A redirect chain that lands somewhere non-200 (e.g. the coming-soon gate
    // capturing /api/* it should not) is a deployment problem, not a subsystem one.
    return out(1, `FAIL — /api/health returned HTTP ${res.status} (expected 200 or 503).`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return out(2, "MISCONFIGURED — 200 but the body is not JSON. Is the URL the health route?");
  }

  const checks = body?.checks ?? {};
  const unhealthy = Object.entries(checks).filter(([, c]) => !c?.ok);
  if (unhealthy.length > 0) {
    return out(
      1,
      `FAIL — HTTP 200 but ${unhealthy.length} check(s) unhealthy: ${unhealthy
        .map(([k, c]) => `${k} (${c.error ?? "no error field"})`)
        .join("; ")}`,
    );
  }
  if (!body?.ok) {
    return out(1, "FAIL — HTTP 200, no unhealthy checks listed, but top-level ok is false.");
  }

  // The identity pin. This is the part a stock uptime checker cannot do.
  const reported = String(body?.checks?.escrow_contract?.address ?? "").toLowerCase();
  if (!reported) {
    return out(
      2,
      "MISCONFIGURED — the response has no escrow_contract.address. Either the target",
      "is not this app's health route, or it predates the identity fields (CC-082).",
    );
  }
  if (reported !== expectedEscrow) {
    return out(
      2,
      `MISCONFIGURED — production reports escrow ${reported}, expected ${expectedEscrow}.`,
      "The site is up and healthy — against a different contract than this repo pins.",
      "That is the silent wrong-escrow class (see the health route's own comment);",
      "check the deployment's NEXT_PUBLIC_ESCROW_CONTRACT before any task funds.",
    );
  }

  const locked = body?.checks?.escrow_contract?.total_locked ?? "?";
  return out(
    0,
    `PASS — ${url} healthy; escrow ${shortAddr(reported)} holding ${locked} (raw units).`,
  );
}

function shortErr(err) {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : String(err);
}

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?";
}

process.exitCode = await main();
