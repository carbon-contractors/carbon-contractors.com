#!/usr/bin/env node
/**
 * discovery-stage.mjs — CC-032 Discovery-stage lifecycle harness.
 *
 * Drives the CC-032 scope exactly as the 2026-08-11 triage pass defined it:
 *
 *   register → discover via MCP (search_whitepages, get_contractor) → the
 *   worker is findable with correct categories, rate and availability.
 *
 * Everything here is OFF-CHAIN: registration and profile updates are signed
 * messages (the server verifies them with its own public client), and the MCP
 * read tools need no authentication at all. Nothing broadcasts, no wallet
 * needs gas or USDC, and the only money-adjacent surface touched is none.
 *
 * House style follows funding-stage.mjs (CC-077): --dry-run default (validates
 * config, prints the exact plan, contacts nothing), --execute for real,
 * numbered misconfiguration report (exit 2), verdict line last (PASS/FAIL,
 * exit 0/1). The pure logic lives in discovery-config.mjs / discovery-cases.mjs
 * / discovery-args.mjs so the suite can pin it hermetically.
 *
 * The wallet: a THROWAWAY EOA. Either DISCOVERY_WALLET_PRIVATE_KEY from the
 * env, or --generate-wallet for an ephemeral key minted at run time and
 * discarded after (preferred — nothing lands on disk). The key never rides in
 * the config object, never in a log line.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import {
  validateDiscoveryConfig,
  discoveryConfigFailureMessage,
} from "./discovery-config.mjs";
import {
  selectDiscoveryCase,
} from "./discovery-cases.mjs";
import { parseDiscoveryArgs, DISCOVERY_USAGE } from "./discovery-args.mjs";

// ── Step/verdict plumbing (audit-script house style) ─────────────────────────

const steps = [];
function step(n, title, evidence, expect) {
  steps.push({ n, title, evidence: evidence ?? "", expect: expect ?? "" });
  process.stdout.write(
    `\n${n === 99 ? "last" : n + "."} ${title}\n` +
      (evidence ? `   evidence ${evidence}\n` : "") +
      (expect ? `   expect   ${expect}\n` : ""),
  );
}

function problems(msg) {
  process.stdout.write(`   · ${msg}\n`);
  failures.push(msg);
}

let failures = [];
let checks = 0;
function check(ok, what) {
  checks++;
  if (ok) {
    process.stdout.write(`   ✓ ${what}\n`);
  } else {
    problems(what);
  }
  return ok;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

async function postJson(url, body, headers = {}) {
  return requestJson("POST", url, body, headers);
}
async function getJson(url, headers = {}) {
  return requestJson("GET", url, null, headers);
}
async function patchJson(url, body, headers = {}) {
  return requestJson("PATCH", url, body, headers);
}

async function requestJson(method, url, body, headers) {
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "follow",
    });
    const text = await res.text();
    if (RETRYABLE_STATUS.has(res.status) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "5");
      process.stdout.write(
        `   … HTTP ${res.status} from ${url} — retry ${attempt}/2 after ${retryAfter}s\n`,
      );
      await sleep(Math.min(Math.max(retryAfter, 1), 30) * 1000);
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body (proxy page, empty 202) — status + raw text is the evidence
    }
    return { status: res.status, json, text, headers: res.headers };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Minimal MCP Streamable-HTTP client (no SDK — the transport is JSON-RPC
//    over POST with SSE responses; initialize once, reuse the session id) ────

class McpSession {
  constructor(baseUrl) {
    this.mcpUrl = `${baseUrl}/api/basedhuman.mcp`;
    this.sessionId = null;
    this.nextId = 1;
  }

  /** Parse `text/event-stream` bodies into JS values; plain JSON passes through. */
  static parseBody(text) {
    if (text.trimStart().startsWith("{")) {
      try {
        return [JSON.parse(text)];
      } catch {
        return [];
      }
    }
    const events = [];
    let dataLines = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line === "" && dataLines.length > 0) {
        // SSE events are terminated by a blank line; but a final event may not
        // carry one before the stream ends — flushed after the loop too.
        events.push(dataLines.join("\n"));
        dataLines = [];
      }
    }
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
    const values = [];
    for (const evt of events) {
      try {
        values.push(JSON.parse(evt));
      } catch {
        // keep-alive comment or non-JSON event — ignore
      }
    }
    return values;
  }

  async rpc(method, params, isNotification = false) {
    const id = isNotification ? undefined : this.nextId++;
    const payload = { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params };
    const res = await postJson(this.mcpUrl, payload, {
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    });
    const sessionHeader = res.headers.get("mcp-session-id");
    if (sessionHeader) this.sessionId = sessionHeader;
    if (isNotification) return null; // 202 Accepted, empty body
    const values = McpSession.parseBody(res.text);
    const match = values.find((v) => v && v.id === id) ?? values.find((v) => v && v.result !== undefined);
    if (match && match.error) {
      return { __rpcError: match.error };
    }
    return match ? match.result : { __noResponse: true, status: res.status, text: res.text.slice(0, 400) };
  }

  async initialize() {
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cc032-discovery-harness", version: "1.0.0" },
    });
    if (!result || result.__rpcError || result.__noResponse) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(result).slice(0, 300)}`);
    }
    await this.rpc("notifications/initialized", {}, true);
    return result;
  }

  /** tools/call → parsed content JSON, or { __error } carrying the tool's error payload.
   *  Transport-level failures (dropped/expired session, non-JSON body) are not
   *  tool verdicts — a live run must not FAIL on one. Re-initialize once and
   *  retry; only a second failure (or a genuine tool error) surfaces. */
  async callTool(name, args, attempt = 0) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if ((!result || result.__rpcError || result.__noResponse) && attempt < 1) {
      process.stdout.write(
        `   … MCP transport error on ${name} (${JSON.stringify(result).slice(0, 120)}) — re-initializing session, retrying once\n`,
      );
      this.sessionId = null;
      await this.initialize();
      return this.callTool(name, args, attempt + 1);
    }
    if (!result || result.__rpcError) {
      return { __error: { transport: JSON.stringify(result).slice(0, 300) } };
    }
    if (result.isError) {
      const text = result.content?.[0]?.text ?? "{}";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
      return { __error: parsed };
    }
    const text = result.content?.[0]?.text;
    if (typeof text !== "string") return { __error: { transport: "no text content" } };
    try {
      return JSON.parse(text);
    } catch {
      return { __error: { transport: `non-JSON tool output: ${text.slice(0, 200)}` } };
    }
  }
}

// ── Registration / profile message builders (route contracts, mirrored) ─────

function registrationMessage({ categories, rateUsdc, nonce, timestamp }) {
  return JSON.stringify({
    categories,
    rate_usdc: rateUsdc,
    nonce,
    timestamp,
  });
}

function profileUpdateMessage({ wallet, timestamp, availability, rateUsdc, categories }) {
  return JSON.stringify({
    action: "profile-update",
    wallet,
    timestamp,
    ...(availability !== undefined ? { availability } : {}),
    ...(rateUsdc !== undefined ? { rate_usdc: rateUsdc } : {}),
    ...(categories !== undefined ? { categories } : {}),
  });
}

/** Fresh nonce per registration — the route rejects replays (409). */
function freshNonce() {
  return randomBytes(16).toString("hex");
}

async function register(account, baseUrl, { categories, rateUsdc }) {
  const message = registrationMessage({
    categories,
    rateUsdc,
    nonce: freshNonce(),
    timestamp: Math.floor(Date.now() / 1000),
  });
  const signature = await account.signMessage({ message });
  return postJson(`${baseUrl}/api/register`, {
    message,
    signature,
    wallet: account.address,
  });
}

async function patchProfile(account, baseUrl, update) {
  const message = profileUpdateMessage({
    wallet: account.address,
    timestamp: Math.floor(Date.now() / 1000),
    ...update,
  });
  const signature = await account.signMessage({ message });
  return patchJson(`${baseUrl}/api/profile`, { message, signature, wallet: account.address });
}

/** The profile fields every discovery surface must agree on. */
function profileShape(entry) {
  return JSON.stringify({
    categories: [...(entry.categories ?? [])].sort(),
    rate: entry.rate_usdc,
    availability: entry.availability,
  });
}

/** Find our worker in a search_whitepages result set. */
function findInSearch(payload, wallet) {
  const results = payload?.results ?? [];
  return results.find((r) => r.wallet?.toLowerCase() === wallet.toLowerCase()) ?? null;
}

// ── Plan rendering (dry-run) ─────────────────────────────────────────────────

function renderDryRun(parsed, config, caseDef) {
  const lines = [];
  lines.push(`── CC-032 discovery-stage harness ────────────────────────────────`);
  lines.push(`mode      dry-run (plan only — no HTTP, no registration)`);
  lines.push(`case      ${caseDef.caseKey ?? "systematic"} — ${caseDef.title}`);
  lines.push(`target    ${config.baseUrl}`);
  lines.push("");
  lines.push(`plan`);
  lines.push(`  1. Wallet — ${parsed.generateWallet ? "ephemeral (generated at --execute, never on disk)" : `from ${config.walletKeyEnvName}`}`);
  lines.push(`  2. POST /api/register — signed message, 2 categories, distinct rate`);
  lines.push(`  3. MCP initialize (unauthenticated — read tools allow it) → search_whitepages per category`);
  lines.push(`  4. get_contractor by wallet (mixed case — CC-002 casing tolerance) and by UUID`);
  lines.push(`  5. GET /api/profile?wallet= — the HTTP surface, same fields`);
  lines.push(`  6. Cross-surface consistency assert (categories, rate, availability)`);
  lines.push(`  7. Negative control — unregistered wallet must 404 / CONTRACTOR_NOT_FOUND`);
  lines.push(`  last. Hygiene — PATCH availability 'offline' (row stays visible, unbookable)`);
  lines.push("");
  lines.push(`ASSERT CLEAN OUTCOME: ${caseDef.assertClean}`);
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let parsed;
  let caseKey, caseDef;
  try {
    parsed = parseDiscoveryArgs(process.argv.slice(2));
    ({ caseKey, caseDef } = selectDiscoveryCase(parsed.caseKeys));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${DISCOVERY_USAGE}\n`);
    process.exit(2);
  }

  const envCheck = validateDiscoveryConfig(process.env, {
    ephemeralWallet: parsed.generateWallet,
  });
  if (!envCheck.ok) {
    process.stderr.write(discoveryConfigFailureMessage(envCheck.problems) + "\n");
    process.exit(2);
  }
  const config = envCheck.config;

  if (parsed.dryRun) {
    process.stdout.write(renderDryRun(parsed, config, { ...caseDef, caseKey }) + "\n");
    process.exit(0);
  }
  if (!parsed.execute) {
    process.stderr.write(`No mode given.\n\n${DISCOVERY_USAGE}\n`);
    process.exit(2);
  }

  // --execute from here on. Resolve the wallet.
  let account;
  if (parsed.generateWallet) {
    account = privateKeyToAccount(generatePrivateKey());
    process.stdout.write(
      `wallet    ephemeral throwaway EOA ${account.address} (minted for this run; discarded after)\n`,
    );
  } else {
    const key = process.env[config.walletKeyEnvName]?.trim();
    try {
      account = privateKeyToAccount(key);
    } catch {
      process.stderr.write(
        `${config.walletKeyEnvName} could not be parsed as a private key (value never printed).\n`,
      );
      process.exit(2);
    }
  }

  failures = [];
  const base = config.baseUrl;
  const wallet = account.address;

  // Health first — a down deployment must fail as TRANSIENT, not as test FAIL.
  step(0, "Deployment reachable", `GET ${base}/api/health`, "200 {ok:true}");
  const health = await getJson(`${base}/api/health`);
  if (health.status !== 200 || !health.json?.ok) {
    process.stdout.write(`\nTRANSIENT — /api/health answered ${health.status}: ${health.text.slice(0, 200)}\n`);
    process.exit(1);
  }
  check(true, `health ok (escrow ${health.json?.checks?.escrow_contract?.address ?? "?"}, chain ${health.json?.checks?.escrow_contract?.chain ?? "?"})`);

  // ── Registration ──
  step(1, caseDef.kind === "upsert" ? "Register the wallet (FIRST registration)" : "Register the throwaway wallet",
    `POST ${base}/api/register — signed message: 2 categories, distinct rate`,
    `200 {ok:true, wallet:"${wallet.toLowerCase()}"}`);
  const reg1 = await register(account, base, {
    categories: ["pet-services", "cleaning"],
    rateUsdc: 42.5,
  });
  if (!check(reg1.status === 200 && reg1.json?.ok === true, `register answered 200 ok:true (${reg1.status} ${reg1.text.slice(0, 160)})`)) {
    finish();
  }
  check(reg1.json?.wallet === wallet.toLowerCase(), "server echoed the normalised (lowercase) wallet");

  // ── MCP search_whitepages ──
  step(2, "MCP session + search_whitepages finds the new worker in BOTH registered categories",
    `initialize ${base}/api/basedhuman.mcp (unauthenticated) → tools/call search_whitepages`,
    "worker present in pet-services AND cleaning results with wallet/categories/rate_usdc/availability/reputation_score");
  const mcp = new McpSession(base);
  const init = await mcp.initialize();
  check(init?.serverInfo?.name === "base-human-mcp", `MCP server: ${init?.serverInfo?.name} v${init?.serverInfo?.version}`);

  const searchPet = await mcp.callTool("search_whitepages", { category: "pet-services" });
  const searchCleaning = await mcp.callTool("search_whitepages", { category: "cleaning" });
  if (searchPet.__error || searchCleaning.__error) {
    check(false, `search_whitepages errored: ${JSON.stringify(searchPet.__error ?? searchCleaning.__error).slice(0, 200)}`);
  } else {
    const inPet = findInSearch(searchPet, wallet);
    const inCleaning = findInSearch(searchCleaning, wallet);
    check(Boolean(inPet), `found in pet-services (count ${searchPet.count}, our wallet ${inPet ? "present" : "ABSENT"})`);
    check(Boolean(inCleaning), `found in cleaning (count ${searchCleaning.count})`);
    if (inPet) {
      check(JSON.stringify(inPet.categories) === JSON.stringify(["pet-services", "cleaning"]) ||
            JSON.stringify([...inPet.categories].sort()) === JSON.stringify(["cleaning", "pet-services"]),
        `categories round-trip exactly: ${JSON.stringify(inPet.categories)}`);
      check(inPet.rate_usdc === 42.5, `rate_usdc round-trips: ${inPet.rate_usdc}`);
      check(typeof inPet.reputation_score === "number", `reputation_score present: ${inPet.reputation_score}`);
    }
    if (inPet && inCleaning) {
      check(profileShape(inPet) === profileShape(inCleaning), "both category searches return the identical profile");
    }
  }

  // ── get_contractor by wallet (casing) and by UUID ──
  step(3, "get_contractor by WALLET — mixed-case lookup (CC-002 heritage: lookups must be casing-tolerant)",
    `tools/call get_contractor {wallet: "<checksummed>"}`,
    "ok:true, contractor with id (UUID), categories, rate, availability");
  const mixedCase = wallet.substring(0, 6) + wallet.slice(6, 42).toUpperCase() + wallet.slice(42) + ""; // uppercase interior hex — same address, different casing
  const byWallet = await mcp.callTool("get_contractor", { wallet: mixedCase });
  let contractorId = null;
  if (byWallet.__error) {
    check(false, `get_contractor by wallet errored: ${JSON.stringify(byWallet.__error).slice(0, 200)}`);
  } else {
    const c = byWallet.contractor;
    contractorId = c?.id ?? null;
    check(byWallet.ok === true && Boolean(c), `contractor found via mixed-case wallet: ${c?.wallet}`);
    check(c?.wallet === wallet.toLowerCase(), "returned wallet is the normalised lowercase form");
    check(c?.rate_usdc === 42.5 && c?.availability === "available", `rate ${c?.rate_usdc}, availability ${c?.availability}`);
    check(typeof c?.accepts_auto_booking === "boolean", `accepts_auto_booking present: ${c?.accepts_auto_booking}`);
  }

  step(4, "get_contractor by UUID — the id the wallet lookup returned",
    `tools/call get_contractor {id: "${contractorId ?? "<uuid>"}"}`,
    "identical contractor profile to the wallet lookup");
  if (contractorId) {
    const byId = await mcp.callTool("get_contractor", { id: contractorId });
    if (byId.__error) {
      check(false, `get_contractor by id errored: ${JSON.stringify(byId.__error).slice(0, 200)}`);
    } else {
      const c = byId.contractor;
      check(c?.wallet === wallet.toLowerCase() && c?.rate_usdc === 42.5, "UUID lookup returns the same contractor");
      check(profileShape(c) === profileShape(byWallet.contractor), "wallet-lookup and UUID-lookup profiles are identical");
    }
  } else {
    check(false, "skipped — no UUID captured in step 3");
  }

  // ── HTTP surface ──
  step(5, "GET /api/profile — the plain HTTP read agrees with MCP",
    `GET ${base}/api/profile?wallet=${wallet}`,
    "200 {ok:true, profile{categories, rate_usdc, availability}} matching MCP");
  const httpProfile = await getJson(`${base}/api/profile?wallet=${wallet}`);
  if (!check(httpProfile.status === 200 && httpProfile.json?.ok === true, `/api/profile answered ${httpProfile.status}`)) {
    finish();
  }
  const hp = httpProfile.json.profile;
  check(hp.rate_usdc === 42.5 && hp.availability === "available", `HTTP profile: rate ${hp.rate_usdc}, availability ${hp.availability}`);
  check(
    JSON.stringify([...hp.categories].sort()) === JSON.stringify(["cleaning", "pet-services"]),
    `HTTP categories match: ${JSON.stringify(hp.categories)}`,
  );

  // ── Case-specific second act ──
  if (caseKey === "alreadyRegistered") {
    step(6, "SECOND registration with different categories/rate — upsert, not duplicate",
      `POST /api/register again — categories ["event-setup"], rate 30`,
      "200 ok:true; get_contractor returns ONE row with the NEW values; old category no longer returns the wallet");
    const reg2 = await register(account, base, { categories: ["event-setup"], rateUsdc: 30 });
    check(reg2.status === 200 && reg2.json?.ok === true, `second register answered ${reg2.status} ${reg2.text.slice(0, 120)}`);
    const after = await mcp.callTool("get_contractor", { wallet });
    const c = after.__error ? null : after.contractor;
    check(Boolean(c) && JSON.stringify(c.categories) === JSON.stringify(["event-setup"]) && c.rate_usdc === 30,
      `row updated in place: categories ${JSON.stringify(c?.categories)}, rate ${c?.rate_usdc}`);
    const oldSearch = await mcp.callTool("search_whitepages", { category: "pet-services" });
    check(!findInSearch(oldSearch.__error ? { results: [] } : oldSearch, wallet), "dropped category search no longer returns the wallet");
    const newSearch = await mcp.callTool("search_whitepages", { category: "event-setup" });
    check(Boolean(findInSearch(newSearch.__error ? { results: [] } : newSearch, wallet)), "new category search returns the wallet");
  } else if (caseKey === "profileUpdate") {
    step(6, "PATCH /api/profile — signed profile-update changes the row",
      `PATCH ${base}/api/profile — availability offline, rate 55, categories ["moving-hauling"]`,
      "200 ok:true; every surface reads the PATCHed values");
    const patch = await patchProfile(account, base, {
      availability: "offline",
      rateUsdc: 55,
      categories: ["moving-hauling"],
    });
    check(patch.status === 200 && patch.json?.ok === true, `PATCH answered ${patch.status} ${patch.text.slice(0, 120)}`);
    const after = await mcp.callTool("get_contractor", { wallet });
    const c = after.__error ? null : after.contractor;
    check(Boolean(c) && c.availability === "offline" && c.rate_usdc === 55 && JSON.stringify(c.categories) === JSON.stringify(["moving-hauling"]),
      `MCP reads back the PATCH: availability ${c?.availability}, rate ${c?.rate_usdc}, categories ${JSON.stringify(c?.categories)}`);
    const httpAfter = await getJson(`${base}/api/profile?wallet=${wallet}`);
    const hp2 = httpAfter.json?.profile;
    check(hp2?.availability === "offline" && hp2?.rate_usdc === 55, `HTTP reads back the PATCH: availability ${hp2?.availability}, rate ${hp2?.rate_usdc}`);
  }

  // ── Negative control ──
  step(7, "Negative control — an UNREGISTERED wallet must not be found",
    "get_contractor {wallet: <random>} + GET /api/profile?wallet=<same>",
    "MCP code CONTRACTOR_NOT_FOUND; HTTP 404 {ok:false}");
  const ghost = privateKeyToAccount(generatePrivateKey()).address;
  const ghostMcp = await mcp.callTool("get_contractor", { wallet: ghost });
  check(ghostMcp.__error?.code === "CONTRACTOR_NOT_FOUND", `MCP refused the ghost: ${JSON.stringify(ghostMcp.__error ?? ghostMcp).slice(0, 200)}`);
  const ghostHttp = await getJson(`${base}/api/profile?wallet=${ghost}`);
  check(ghostHttp.status === 404 && ghostHttp.json?.ok === false, `HTTP 404 for the ghost (got ${ghostHttp.status})`);

  // ── Hygiene ──
  step(99, "Hygiene — leave the row 'offline' (visible in the whitepages, unbookable) and close the MCP session",
    `PATCH availability=offline → DELETE MCP session`,
    "row availability 'offline'; session closed");
  const current = await mcp.callTool("get_contractor", { wallet });
  const curAvail = current.__error ? null : current.contractor?.availability;
  if (curAvail !== "offline") {
    const hyg = await patchProfile(account, base, { availability: "offline" });
    check(hyg.status === 200 && hyg.json?.ok === true, `hygiene PATCH answered ${hyg.status}`);
  } else {
    check(true, "row already offline (case act set it) — no further PATCH needed");
  }
  const final = await mcp.callTool("get_contractor", { wallet });
  check(!final.__error && final.contractor?.availability === "offline", `final row state: ${final.__error ? `read failed — ${JSON.stringify(final.__error).slice(0, 200)}` : final.contractor?.availability}`);

  finish();

  function finish() {
    process.stdout.write("\n");
    if (failures.length === 0) {
      process.stdout.write(`PASS — ${checks} checks, discovery loop proven: register → search_whitepages → get_contractor (wallet, casing, UUID) → /api/profile all agree; negative control refused.\n`);
      process.exit(0);
    }
    process.stdout.write(`FAIL — ${checks - failures.length}/${checks} checks passed. Problems:\n`);
    for (const f of failures) process.stdout.write(`· ${f}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stdout.write(`\nUNEXPECTED — harness crashed before a verdict: ${err?.stack ?? err}\n`);
  process.exit(1);
});
