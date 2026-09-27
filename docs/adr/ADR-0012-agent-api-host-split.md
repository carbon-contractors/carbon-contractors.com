---
id: ADR-0012
title: Two front doors — a bot-friendly API host for agents, a protected website for humans
status: proposed
date: 2026-09-27
deciders: Aaron Clifft (pending)
depends-on: ADR-0006 (D6 — DNS for humans, ENS for agents), ADR-0009 (session cookies), ADR-0003 / ADR-0011 (uptime and monitoring), ADR-0004 (published claims)
amends: ADR-0006 D6 (which record carries the agent pointer)
resolves: the edge-protection conflict found 2026-09-27 (Cloudflare Bot Fight Mode blocking datacenter callers)
blocks: CC-039 (public launch), CC-044 (standalone MCP package default URL), CC-102 (MCP auth discovery location)
area: architecture
epic: public-launch
---

# ADR-0012 — Two front doors: a bot-friendly API host for agents, a protected website for humans

## Context

Carbon Contractors has two kinds of customer, and they arrive in opposite ways:

- **Humans** (workers, and the PO) use a browser. They're served best by the usual web
  defences: bot challenges, JavaScript checks, blocking datacenter IPs.
- **AI agents** hire those humans. They call the MCP endpoint and the REST routes from servers:
  AWS, GCP, Azure, the model providers' own infrastructure. **To every standard bot defence,
  a paying agent looks exactly like the thing being blocked.**

Today both share one host, `www.carbon-contractors.com`, proxied through Cloudflare, so they share
one bot policy. Measured 2026-09-25 → 27:

- With Cloudflare **Bot Fight Mode** on (free plan), every request from GitHub's runners to
  `/api/health` got **HTTP 403 (`server: cloudflare`)**, while the same URL answered 200 from a home
  connection. The same rule sat in front of `/api/basedhuman.mcp`. Post-launch, it would have been
  refusing agents, silently, at the edge, with nothing in the app's logs.
- On the free plan, Bot Fight Mode is zone-wide and **can't be skipped per path**. The per-path
  exceptions (Super Bot Fight Mode skip rules) need Cloudflare Pro.
- Bot Fight Mode was turned off on 2026-09-27 as a pre-launch stopgap; `verify-uptime` went green
  on the next run. That leaves the human site with no bot protection, which is fine behind the
  coming-soon gate and not fine after launch.

The routes don't split cleanly by file. The website's own front end calls almost every REST route
(`/api/auth/session`, `/api/tasks`, `/api/offers/*`, `/api/channels`, `/api/verdict`, `/api/dispute`,
`/api/profile`, `/api/register`, `/api/reputation`, and `/api/basedhuman.mcp/challenge`) with the
ADR-0009 session cookie, and agents call the same routes with wallet-signature headers
(`x-caller-wallet` / `-signature` / `-nonce`). **The split is by audience and auth method, not by
code.**

The PO's framing: *move the endpoint away and let the bots go nuts; keep the website for the
humans.*

## Decision (proposed)

### D1 — Two hostnames, one deployment

- **`www.carbon-contractors.com`** is the human front door: pages, the dashboard, and the
  same-origin API calls the dashboard makes.
- **`api.carbon-contractors.com`** is the agent front door: the MCP server and every route an
  agent calls.
- Both hostnames point at the **same Vercel project** to start with. No code moves and nothing is
  duplicated. Host-aware middleware decides what each hostname serves (D2). Separating the hosting
  later is a DNS change, not a contract change (D6).

### D2 — What each host serves, and which auth it honours

| | `www.` (humans) | `api.` (agents) |
| :-- | :-- | :-- |
| Pages / HTML | yes | **no** (404, not a redirect) |
| `/api/basedhuman.mcp`, `/challenge` | yes (the dashboard uses the challenge) | **yes, canonical** |
| Agent REST (`/api/fund-task`, `/api/verdict`, `/api/dispute`, `/api/tasks`, `/api/reputation`, `/api/profile`) | yes, for the dashboard | **yes, canonical** |
| Worker-only routes (`/api/register`, `/api/offers/*`, `/api/channels`, `/api/auth/session`) | yes | no. These are human actions |
| `/api/health` | yes | yes (monitored separately, D7) |
| `/api/cron/*` | yes (Vercel Cron calls it) | no |
| **Session cookie honoured** | yes (ADR-0009) | **never**. Signature auth only; the host sets no cookies |
| MCP auth discovery (`/.well-known/*`, CC-102) | no | yes |

Refusing cookies on `api.` is a security gain in its own right. The ADR-0009 cookie is host-only and
`SameSite=Strict`, so the browser never sends it there anyway. Making the server refuse it as well
means the bot-exposed host has no ambient authority at all: every request stands on its own
signature, and there's no CSRF surface.

### D3 — Edge protection follows the audience

- **`www.` stays proxied through Cloudflare** (orange cloud). Bot Fight Mode, or Pro's Super Bot
  Fight Mode, can go back on once `api.` exists, because nothing an agent needs lives behind it.
- **`api.` is DNS-only through Cloudflare** (grey cloud). Cloudflare's bot rules never see that
  traffic, and that works on the free plan. Its protection is layered in the app and at Vercel:
  1. **Wallet-challenge auth** on every stateful call (already built).
  2. **Per-endpoint rate limits** via the Upstash-backed limiter (CC-020). **Prerequisite:**
     `UPSTASH_REDIS_REST_URL` / `_TOKEN` set on Vercel; without them the limiter falls back to
     per-instance memory.
  3. **Vercel's platform DDoS mitigation**, plus Vercel firewall *rate-limit* rules scoped to
     `api.`, never *challenge* rules.
- **The rule that makes this work: never put a browser challenge in front of an agent path.** A
  challenge is a 403 to a bot. Any future protection on `api.` must be a limit (429, with
  `Retry-After`), an auth failure (401), or a block of a *specific* abuser, never a
  proof-of-humanity check.

### D4 — Transition: `api.` becomes canonical before launch; `www.` keeps working

- Pre-launch there are no production agents to break, so this is the cheap moment. After launch the
  published URL is a one-way door (ADR-0004's public-claims discipline applies).
- `api.` is announced as **the** MCP endpoint in `/mcp-info`, the `basedhuman-mcp` package default
  (CC-044) and the ENS pointer (D5).
- `www.carbon-contractors.com/api/basedhuman.mcp` **keeps serving**, rather than redirecting, until
  at least launch plus a stated deprecation window. Many MCP clients don't follow a 307/308 on
  `POST`, so a redirect would be a silent break.

### D5 — The agent pointer gets its own record (amends ADR-0006 D6)

ADR-0006 D6 made an ENS `url` text record the canonical machine-readable pointer. With two front
doors that record has to choose, and the ENS convention (ENSIP-5) says `url` means *website*. So:

- **`url`** = `https://www.carbon-contractors.com`: the human front door, per convention. (Measured
  2026-09-27: currently `www.carbon-contractors.com` with no scheme, so it needs fixing either way.)
- **A separate text record for the MCP endpoint** = `https://api.carbon-contractors.com/api/basedhuman.mcp`.
  The key name is an open item. Agents resolve this one.
- Both are written from one source (the BCP-DR "keep it inert, generate from the same source"
  rule), so the two can't drift.

### D6 — The API's URL is the contract; where it runs is not

Because agents only know `api.carbon-contractors.com`, the API can later move to a separate Vercel
project, Cloudflare Workers, or anywhere else by changing a DNS record, with no customer-visible
change. **This ADR doesn't decide to move hosting.** It makes that move cheap and keeps it
reversible.

### D7 — Monitoring covers both doors (CC-118)

- `verify-uptime` checks **both** hosts. The `api.` check must never see a challenge; if it does,
  D3's rule has been broken and that's a **wake-tier** finding, because it means agents are being
  refused.
- One more invariant: `api.` returns 404 for an HTML page and never sets a cookie. That proves the
  host separation is still in force.

## Consequences

- **Bot protection can return for humans without costing agents anything.** The main payoff.
- **The decision to pay for Cloudflare Pro becomes optional.** Free-plan Bot Fight Mode on `www.` is
  compatible with this design. Pro becomes a question of better human-side rules, not of
  unblocking customers.
- **Middleware gains host awareness.** A new, security-relevant branch (which host serves what,
  which auth is honoured), so it needs tests for every cell in the D2 table.
- **Upstash moves from nice-to-have to required**, because it is `api.`'s main throttle.
- **Three published surfaces change before launch:** `/mcp-info`, the npm package default, and the
  ENS records.
- **CSP is unaffected:** the dashboard keeps calling same-origin `/api/*` on `www.`.

## Alternatives considered

- **One host; Cloudflare Pro with per-path skip rules for `/api/*`.** Works, but it ties agent
  access to a paid plan and to a rule nobody watches. Remove the rule, or let the plan lapse, and
  customers are silently locked out. Rejected as the *foundation*; still usable on top of D1 for
  the human side.
- **One host, bot protection permanently off.** Simplest, and today's stopgap, but the human site
  and worker dashboard stay unprotected after launch. Rejected.
- **A separate domain for the API** (e.g. a different registrable name). Stronger isolation, but a
  second domain to renew, protect and keep in the ENS/BCP-DR registers. Rejected: a subdomain gets
  the same edge separation for free.
- **Move the API to separate hosting now.** Premature: there's no load problem and no cost problem
  yet. Deferred by D6, which keeps it a DNS-only change later.

## Open items (for the PO)

1. The ENS text-record key for the MCP endpoint (D5). A custom key such as
   `com.carbon-contractors.mcp`, or wait for an emerging standard?
2. The deprecation window for `www.…/api/basedhuman.mcp` after launch (D4). Suggested: 90 days,
   with the MCP response carrying a deprecation notice from launch day.
3. Cloudflare Pro at launch: now a human-side quality question, not a blocker (Consequences).
4. Whether `/api/profile` and `/api/reputation` (public reads, whitepages) should also be
   rate-limited more tightly on `api.`, since they need no signature and are the obvious scraping
   targets.

## Handover — implementation order

1. **Now (PO):** keep Bot Fight Mode off until step 4 ships. *(Done 2026-09-27.)*
2. **PO:** set `UPSTASH_REDIS_REST_URL` / `_TOKEN` on Vercel (CC-020's operational note).
   Prerequisite for D3.
3. **PO:** add `api.carbon-contractors.com` to the Vercel project; create its Cloudflare DNS record
   as **DNS-only**.
4. **Host-aware middleware (L3, auth/trust boundary):** the D2 table, including cookie refusal on
   `api.`, 404 for pages on `api.`, and a test for every cell.
5. **Published surfaces:** `/mcp-info` shows the `api.` URL; the `basedhuman-mcp` package default
   (CC-044); ENS records per D5; the BCP-DR naming section.
6. **Monitoring:** `verify-uptime` for both hosts plus the host-separation invariant (D7), under the
   CC-118 epic.
7. **PO:** turn Bot Fight Mode back on for `www.` and confirm `verify-uptime` stays green on
   `api.`.
8. **CC-039 gate line:** "Agent API is served canonically from `api.` with no browser challenge in
   its path", checked on launch day.
