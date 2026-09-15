# CC-077 — Funding-stage lifecycle harness (Base Sepolia)

Drives the **rescoped** CC-077 flow (see `docs/backlog/CC-077.md`, "Rescoped 2026-08-28" — everything
above that heading is historical and describes a removed x402 flow):

```
request_human_work            → row 'pending' (offer) or 'accepted' (auto-booking)
worker accepts                → POST /api/offers/accept → 'accepted'        [manual / dashboard]
agent funds from its own wallet → USDC.approve + escrow.createTask          [this harness]
agent confirms                → POST /api/fund-task → 'active'              [this harness]
notification fires to the worker                                             [manual check]
```

There is **no x402 payment challenge** and there never will be one — an x402 settlement is a bare
ERC-20 transfer into a contract with no sweep or rescue (CC-081 Defect 1). Nothing may ever send
USDC to the escrow except `createTask`.

The platform transacts **nowhere** in this flow. `createTask` records `msg.sender` as the agent, so
the harness signs with an agent-held wallet, never a platform key.

## Prerequisites

- A **funded agent wallet on Base Sepolia** holding test USDC
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) plus a little ETH for gas.
- A `.env.local` (never committed — `.env.example` documents var names).
- A reachable instance of the app (dev server or deployment) for the `/api/fund-task` and
  `/api/tasks` steps. `/api/*` is public and bypasses the coming-soon gate.
- A registered worker (via `search_whitepages`) if you are creating a fresh offer.
- The chain parameters (escrow, USDC, chain id, deploy block) come from `chain-constants.json`
  (`networks.base-sepolia`) — the harness never reads them from env and never re-derives them.

## Environment variables

| Var | Required | Notes |
| :-- | :-- | :-- |
| `BASE_SEPOLIA_RPC_URL` | yes | A **dedicated** endpoint (CC-048). Setting it to the public gateway is the same as leaving it unset. |
| `AGENT_WALLET_PRIVATE_KEY` | yes | **New var, defined by this harness.** The agent wallet's key (`0x` + 64 hex), testnet only. It must **not** be `DEPLOYER_PRIVATE_KEY` — that key owns the escrow, and using it would make the platform wallet the on-chain agent, the exact conflation this harness exists to disprove. Add it to `.env.local`; it is never printed or logged (format checked, value read only at `--execute`). |
| `NEXT_PUBLIC_BASE_URL` | yes | Where to reach `/api/*` — e.g. `http://localhost:3000` or the deployment URL. |
| `NEXT_PUBLIC_BASE_NETWORK` | no | If set, must be `testnet` — the harness is pinned to base-sepolia (mainnet is CC-034 and not deployed). |

Config problems are reported **all at once**, never one var at a time. Blank (`VAR=`) counts as
unset (CC-097).

## Modes

- `--dry-run` (default) — validates config and prints the exact execution plan. Moves nothing,
  contacts no RPC. This is the only mode exercised so far.
- `--execute` — performs the plan against Base Sepolia, signing with the agent wallet. Guard cases
  (see below) only `eth_call` even in this mode. Every `--execute` run ends by spawning
  `scripts/audit/verify-escrow-solvency.mjs` and reporting its verdict — pinning the child's escrow
  and USDC env to the same `chain-constants.json` values the run targeted.

## Step 1 is not automated — `--task-id`

`request_human_work` needs a running, authenticated MCP session (wallet challenge), so run it
yourself (your MCP client against the server) and resume the harness with
`--task-id=<payment_request_id>` taken **from that response**. Do not scrape `GET /api/tasks`:
`payment_request_id` is null for unfunded rows (migration 022), deliberately.

The quote response also carries `worker`, `amount_wei`, `deadline_unix`, `review_window_seconds`
and `spec_hash` — pass what you can via the `--worker`, `--amount-usdc`, `--spec-hash` flags
(defaults below). The harness recomputes `task_id_bytes32 = keccak256(payment_request_id)` locally.

Defaults: `--amount-usdc 1`, `--deadline-hours 48`, `--review-window-hours 24`. Testnet-cheap by
design.

## Example invocations

```bash
# Validate config and print the happy-path plan (moves nothing):
node --env-file=.env.local scripts/lifecycle/funding-stage.mjs --dry-run \
  --task-id=cc077-demo-001 --worker=0xWalletOfWorkers --spec-hash=0x…

# Happy path, for real:
node --env-file=.env.local scripts/lifecycle/funding-stage.mjs --execute \
  --task-id=cc077-demo-001 --worker=0xWalletOfWorkers \
  --amount-usdc 1 --deadline-hours 48 --review-window-hours 24 --spec-hash=0x…

# Unhappy paths — one flag per run:
… --execute --case-task-already-exists --task-id=<an ALREADY-FUNDED task's id>
… --execute --case-zero-amount
… --execute --case-invalid-worker
… --execute --case-deadline-passed
… --execute --case-invalid-review-window
… --execute --case-insufficient-allowance --task-id=cc077-demo-002
… --execute --case-insufficient-balance
… --execute --case-fund-task-before-funding --task-id=cc077-demo-003
… --execute --case-worker-amount-mismatch --task-id=cc077-demo-004
```

Exit codes: `0` the expected clean outcome · `1` behaviour did not match CC-077 · `2` bad args or
config.

### Case shapes and why

- **Guard cases** (`task-already-exists`, `zero-amount`, `invalid-worker`, `deadline-passed`,
  `invalid-review-window`, `insufficient-balance`) assert the revert via **`eth_call` simulation,
  never a broadcast**. Every guard in `createTask` runs before `usdc.safeTransferFrom`, so the
  simulation reverts with the identical custom error at zero cost.
- **Fund-flow cases** broadcast real funding, because what is under test is the behaviour around
  real money. `--case-worker-amount-mismatch` locks real USDC in a task the DB row will never
  claim — the run prints a **mandatory recovery** reminder (`escrow.expireTask`, agent-only pull
  refund, ADR-0001 A1.2). Run it; CarbonEscrow has no rescue.
- `--case-fund-task-before-funding` expects **409** with `on_chain_state: "None"` and the row
  untouched; `--case-worker-amount-mismatch` expects **409** and the row *not* going `active`.

## What is NOT automated

- **Step 1, `request_human_work`** — needs a live authenticated MCP session. Manual; resume with
  `--task-id`.
- **Worker offer acceptance** (step 2 of the flow) — manual via the dashboard / auto-booking. The
  harness only checks the row reads `accepted` before funding; `/api/fund-task` enforces it anyway.
- **Step 5, worker notification** — the harness cannot verify delivery through a worker's real
  channel. Remains a **human check**: ask the worker, or inspect the delivery logs. (CC-095 made
  failures visible rather than silent — check them.)
- **`expireTask` refund recovery** after `--case-worker-amount-mismatch` — the run prints the
  reminder and stops. Deliberately not automatic: a second broadcast step in a case whose whole
  point is "the DB refused" muddies the evidence trail. Run it with the agent wallet.
- **Offer expiry / re-targeting and the concurrency cap** — app-layer behaviours owned by CC-094 /
  ADR-0005, not part of this funding harness.
- **The `--execute` runner itself has never been run.** This scaffold pass was `--dry-run` only by
  instruction; the first live `--execute` run (happy path first) is the actual CC-077 execution
  work. Treat its first output with suspicion and reconcile against
  `verify-escrow-solvency.mjs`, which every run invokes.

## CC-032 — Discovery-stage harness (off-chain, no funds)

CC-032 owns the Discovery stage of the split lifecycle (2026-08-11 triage): `register → discover
via MCP (search_whitepages, get_contractor) → worker findable with correct categories, rate and
availability`. Funding is CC-077 above, settlement CC-078, disputes CC-079.

Nothing in this stage touches the chain: registration is a signed message (the server verifies it
with its own public client), profile updates likewise, and the MCP read tools need no
authentication. The harness therefore needs NO RPC URL and NO funded wallet.

### Run it

```bash
# Plan only — validates env, contacts nothing:
node scripts/lifecycle/discovery-stage.mjs --dry-run

# The systematic pass, live, against the deployment named by NEXT_PUBLIC_BASE_URL:
node scripts/lifecycle/discovery-stage.mjs --execute --generate-wallet

# Extra cases — one flag per run:
node scripts/lifecycle/discovery-stage.mjs --execute --generate-wallet --case-already-registered
node scripts/lifecycle/discovery-stage.mjs --execute --generate-wallet --case-profile-update
```

`--generate-wallet` mints an ephemeral throwaway EOA (preferred — nothing lands on disk). Without
it, `DISCOVERY_WALLET_PRIVATE_KEY` must be set: a **throwaway** key, never `DEPLOYER_PRIVATE_KEY`
(that would make the platform owner discoverable as a worker) and never `AGENT_WALLET_PRIVATE_KEY`
(couples a test row to the CC-077 money-path wallet). The key is never printed or logged.

Target: `NEXT_PUBLIC_BASE_URL` (e.g. `https://www.carbon-contractors.com` — **note the www**, the
apex answers 307). `/api/*` is public and bypasses the coming-soon gate.

### What the systematic pass proves

1. **Register** — a fresh wallet signs `{categories, rate_usdc, nonce, timestamp}`; server returns
   `200 {ok:true, wallet}` (normalised lowercase).
2. **search_whitepages** — the new worker appears in BOTH registered categories with wallet,
   categories, rate, availability and reputation_score, identically in each.
3. **get_contractor by wallet** — mixed-case input (CC-002 heritage: lookups normalise casing);
   returns the UUID, full profile, `accepts_auto_booking`.
4. **get_contractor by UUID** — identical profile to the wallet lookup.
5. **GET /api/profile** — the plain HTTP surface agrees with MCP.
6. **Negative control** — an unregistered wallet gets `CONTRACTOR_NOT_FOUND` (MCP) and `404`
   (HTTP): the reads answer from the registry, not a cache.
7. **Hygiene** — the row is left `offline` (visible in the whitepages, unbookable), and the run
   prints the wallet address so the row can be identified in any later cleanup.

Extra cases: `--case-already-registered` (re-registration upserts — onConflict wallet — and the
old category stops matching), `--case-profile-update` (signed `profile-update` PATCH propagates
to every read surface).

Note: the MCP endpoint is rate-limited (30/min per IP) and `/api/*` 60/min — a full pass makes
about a dozen calls, well inside the limits. Transport-level failures (a dropped or expired MCP
session) are retried once via session re-initialisation before being reported — a dropped
session is not a tool verdict.

### Exit codes

`0` PASS · `1` FAIL or TRANSIENT (deployment unreachable) · `2` bad args/config.

## Layout

```
scripts/lifecycle/
  config.mjs          env + chain-constants validation (pure, unit-tested)
  cases.mjs           one flag per CC-077 unhappy path (pure, unit-tested)
  args.mjs            CLI parsing (pure, unit-tested)
  plan.mjs            plan build/render — the same object --dry-run prints and --execute runs
  funding-stage.mjs   CLI entry (self-executing; live runner lives here)
  discovery-config.mjs   CC-032: env validation, no RPC needed (pure, unit-tested)
  discovery-cases.mjs    CC-032: case registry (pure, unit-tested)
  discovery-args.mjs     CC-032: CLI parsing (pure, unit-tested)
  discovery-stage.mjs    CC-032: CLI entry (self-executing; off-chain live runner)
  __tests__/          hermetic vitest tests (offline logic only, CC-060)
```
