# ADR-0011 — The watch surface: a stateful ops dashboard, and a page only when action is needed

- **Status:** proposed
- **Date:** 2026-09-25
- **Issue:** `CC-118` (hub); Linear epic *Monitoring & Alerting — the watch surface*
- **Depends on:** `ADR-0003` (D2, D3, D4, D5), `ADR-0009` (owner session), `ADR-0006` (D8 backup)
- **Amends:** `ADR-0003` D5 (stateless scheduled `getLogs`; "webhook for alerting"), open item *alert routing*
- **Supersedes:** `CC-048` (self-hosted Sepolia node)
- **Deciders:** Aaron Clifft (pending)

## Context

`ADR-0003` made monitoring a correctness dependency and built it cheaply: scheduled GitHub
Actions run read-only scripts that re-derive every invariant from the chain, post to a webhook
on failure, and ping a dead-man's switch on success. The invariants are right. The delivery is
failing its only user.

**Measured 2026-09-25, before launch and with no real money on chain:**

- Every scheduled run from 2026-09-15 to 2026-09-25 was red. **None was a breach.** Solvency,
  owner and signer passed on every run.
- The red came from the watching, not the watched: the public Base Sepolia endpoint tightened
  its `eth_getLogs` cap to 1,000 blocks (three monitors, every run); the CDN refused GitHub's
  datacenter IPs on `/api/health` (reported as a *breach* with pause-intake guidance); one
  monitor skipped on a missing env var. Earlier: 32 of 100 runs red, zero breaches (`CC-104`).
- The hourly cron actually fires 5–7 times a day. GitHub drops scheduled runs under load.
- The stateless design rescans from the deploy block every run: ~1.05M blocks today, growing
  ~43k/day on Base, ~1,000 requests per event per monitor at a 1,000-block cap. One monitor
  alone was measured to overrun the 15-minute job. **This does not converge.** Mainnet is busier.
- Each red run fans out to three channels at once (Discord webhook, heartbeat e-mail/Telegram,
  GitHub's failed-workflow e-mail), and repeats every run until it clears, with no "resolved".

The PO's own statement of the requirement, which this ADR treats as a design constraint rather
than a preference: *interruptions are expensive; alert fatigue has already set in pre-launch; a
push-everything model does not work for how I work; notify me only when something needs my
attention and action.* An alert channel that is muted is not an alert channel (`ADR-0003`), and
the person muting it is the only responder the platform has.

The PO asked whether the answer is our own Base node. It is not the first answer — see D1.

## Decision (proposed)

The model is a SIEM manager in miniature (the PO's reference is `wazuh-manager`): **checks
report state into one store; one screen shows the state; one rule engine decides what is worth
interrupting a human for.** Collection, display and paging become three separate concerns
instead of one script that does all three on every run.

### D1 — Read the chain through a dedicated RPC provider; do not self-host a node yet

- **Primary:** a paid/free-tier dedicated RPC provider per network (`BASE_SEPOLIA_RPC_URL`
  now, a separate mainnet URL for `CC-034`), chosen for its `eth_getLogs` block-range cap.
  The cap is recorded in `RPC_MAX_BLOCK_RANGE` (repo variable) next to the URL.
- **Fallback / witness:** the public endpoint, or a second provider. When two sources disagree
  on a money fact (`totalLocked`, owner, signer), that disagreement is itself a finding.
- **Rejected for now: running our own Base node.** Base is a public OP Stack L2, so a node is
  possible (execution client + `op-node` + an L1 RPC). But a mainnet node is multi-TB of fast
  NVMe that must stay synced around the clock — a new always-on system to monitor, which adds
  alerts rather than removing them — and it treats the symptom (request volume) of a design
  problem (D2). **Revisit after mainnet** as an *independent witness* for owner/signer events
  and the KMS audit cross-reference (`CC-048` phase 3's only unique value).

### D2 — Stateful, incremental collection (amends ADR-0003 D5)

- Each chain check keeps a **cursor** (last fully-scanned block) and the derived facts it needs
  (tasks, deadlines, privileged events) in Supabase, in `ops_*` tables that are
  **service-role only** — revoke anon/authenticated in the same migration (`CC-062` rule).
- A run reads `cursor+1 .. head − confirmations` only: a handful of requests, not a thousand.
  A safety overlap re-reads the last N blocks to absorb reorgs.
- A **weekly full rescan** reconciles the stored state against a from-genesis sweep and alarms
  on any difference. This keeps `ADR-0003` D3's property that the chain, not our store, is the
  authority: the store is a cache that is regularly proven against its source.
- Every check writes a **result row** (check, class, verdict line, observed facts, duration,
  source RPC) whatever the outcome. History becomes queryable instead of living in Actions logs.

### D3 — Scheduling: results matter more than which runner produced them

- The runner can stay GitHub Actions initially, or move to Vercel Cron. The dashboard shows
  **"last verified"** per check, so a delayed or dropped schedule is visible as staleness,
  not silently absorbed.
- The external dead-man's switch (`ADR-0003` D5, path 2) remains the page for "the collector
  itself has stopped", because the dashboard cannot report its own host being down.

### D4 — The watch surface: one owner-only page

An `/ops` page, gated to the owner wallet via the `ADR-0009` session and an explicit owner
allowlist (never public, never indexed). It answers, at a glance, in this order:

1. **Is money safe?** Solvency, owner, signer, privileged events — green / amber / red.
2. **Is anything waiting on me?** Open incidents, each with its one next action and runbook link.
3. **Are we able to look?** Per-check freshness ("verified 12 min ago"), RPC health (latency,
   error rate, range cap), uptime, collector heartbeat.
4. **What's happening?** Tasks in flight, `totalLocked`, recent lifecycle events, app errors.

Pull, not push: the page is where curiosity goes, so notifications don't have to carry it.
Design constraints for readability: status first, one screen without scrolling on desktop,
plain-language labels, no raw logs above the fold, history one click down.

### D5 — Incidents and the paging policy

Each check is a small state machine: `ok → degraded → incident → resolved`.

| Situation | Class | What happens |
| :-- | :-- | :-- |
| Invariant observed violated on a wake-tier check | breach | **Page now.** Opens an incident. |
| Could not look (RPC, edge, config) — first occurrence | unchecked / misconfig | Dashboard only (amber). |
| Could not look, persisting beyond the tolerance (default 6h; shorter on mainnet wake-tier) | degraded → incident | **Page once.** "Money checks have been blind for 6h." |
| Incident clears | resolved | **One** "resolved" message, closing the loop. |
| App errors, single failures, skips, drift below thresholds | — | Dashboard only. |

- **Page on state transitions, never on every run.** An open incident does not re-page; it
  re-pages only on escalation (e.g. breach while already degraded).
- **One channel: Telegram.** Discord and e-mail are retired as paging paths. GitHub's own
  failed-workflow e-mails are turned off (a PO notification setting).
- **Every page answers three questions in its first three lines:** what happened; *is money
  at risk?* (yes / no / unknown); the one thing to do next, with the dashboard link.
- **Testnet pages are labelled `TESTNET`.** Pre-mainnet, the PO may set testnet breaches to
  dashboard-only; on mainnet the policy above is the floor, not a preference.

**Interim, shipped 2026-09-25 (PR #234):** the webhook fires on `breach` only; `misconfig` and
`unchecked` withhold the heartbeat so the dead-man's switch's grace period supplies the
"page once when it persists" behaviour, without new infrastructure.

### D6 — Responder attention is a requirement

For a platform with one responder, notification design is part of correctness:

- No alert without an action. If the correct response is "wait", it is not a page.
- No repetition. Silence after a page means "still open, nothing new" — the dashboard shows it.
- No ambiguity about severity: money-at-risk is stated, never implied by tone or emoji.
- An optional daily digest (off by default) is the only scheduled message, and it is opt-in.

### D7 — The app-error relay follows the same policy

`src/instrumentation.ts` posts uncaught request errors to the same webhook, de-duplicated per
instance. It moves to recording into the `ops_*` store (dashboard), paging only on a sustained
error rate on money routes (`/api/fund-task`, `/api/verdict`, MCP write tools).

## Consequences

- **`CC-048` closes `wontfix`**, superseded by D1: its rate-limit motivation is solved by a
  provider and D2; its KMS-cross-reference value is deferred to a post-mainnet witness.
- **`ADR-0003` D5 is amended**, not replaced: still near-zero cost, still no paid indexer, still
  two independent alerting paths — but collection becomes incremental and stateful, and D3's
  "alert on absence" is expressed as freshness on the dashboard plus the dead-man's switch.
- **New tables and a new owner-only page** enter the security surface; both go through the
  day-of security sweep, and `/ops` is L3 work (auth/trust boundary).
- **The monitors' scripts survive.** They become collectors that also write results; running
  one by hand keeps working exactly as today.

## Alternatives considered

- **Self-hosted Base node** — rejected for now (D1).
- **Paid indexer / managed alerting (e.g. an observability SaaS)** — still rejected at this
  volume (`ADR-0003` D5); revisit if D2's store becomes the bottleneck.
- **Keep stateless, just tune thresholds** — rejected: request volume grows without bound, and
  tuning cannot produce "page once on transition" without state.
- **Grafana / Prometheus stack** — capable, but another self-hosted system to keep alive; the
  data volume fits in Supabase and a single Next.js page.

## Open items (for the PO)

1. Which RPC provider(s) — choose on `eth_getLogs` range cap and Base support, not price.
2. The "blind for" tolerance before a degraded check pages: 6h testnet? 1h mainnet wake-tier?
3. Should testnet breaches page at all before mainnet, or be dashboard-only?
4. Runner: stay on GitHub Actions, or move collection to Vercel Cron?

## Handover — implementation order

Mirrored as sub-issues under the `CC-118` Linear epic.

1. **Stop the bleeding** — PR #234 (range refusals → MISCONFIG, 403 not a breach, EAS env,
   breach-only webhook). *Done pending merge.*
2. **PO actions** — dedicated RPC + `RPC_MAX_BLOCK_RANGE` variable; webhook → Telegram
   (`MONITOR_WEBHOOK_STYLE`, `MONITOR_TELEGRAM_CHAT_ID`); heartbeat grace 6h and its
   integration → Telegram only; GitHub failed-workflow e-mails off; Vercel bypass rule for
   `/api/health` (confirm with the header the #234 monitor now prints).
3. **`ops_*` schema** — results, cursors, incidents, derived chain facts; RLS-revoked.
4. **Collectors write results** — `run-monitors.mjs` persists every result row.
5. **Incremental cursors** for the three sweeping monitors + weekly full-rescan reconciliation.
6. **Incident engine** — transitions, page-once, resolved messages, tolerance windows (D5).
7. **`/ops` dashboard** — owner-gated, the four questions in order (D4).
8. **App-error relay → store** (D7).
9. **Mainnet cut-over** — mainnet RPC, mainnet tolerances, runbook update; gates `CC-039`.
10. **Post-mainnet (deferred)** — independent witness node, KMS audit cross-reference.
