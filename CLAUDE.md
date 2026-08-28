# CLAUDE.md

Orientation for Claude sessions on this repo. This file is a **fast index of hazards and pointers**,
not the reasoning itself — the reasoning lives in `docs/adr/`, `docs/backlog/` and
`docs/Lessons-Learned.md`, where it can be read on demand. Keep entries here short; long prose here
goes stale silently, and has (see §*Where truth lives*).

## Who owns what

**Claude is Lead Dev. Aaron is Product Manager.**

So product decisions — launch sequencing, priorities, what gets claimed publicly, what is out of
scope — are Aaron's. They appear in this file because the Lead Dev needs to know them, not because
the Lead Dev owns them. Where one is recorded here or in an ADR, implement it; don't re-litigate it
or quietly "fix" it (`CC-081` Defect 2 and `CC-075` are the worked example of what re-deriving a
settled decision costs). Raise a concern once, then build.

Engineering calls — architecture, mechanism, sequencing of the work itself — are Claude's to propose
and Aaron's to veto.

**We are building and discovering this together, so some drift in this file is expected.** It is not
a spec handed down; it is a shared working note that trails slightly behind what we have just learned.
If you find something stale, correct it and carry on — that is maintenance, not a finding.

## What this is

Carbon Contractors — a Human-as-a-Service marketplace on Base. AI agents discover human workers over
MCP, fund tasks with USDC through x402, and the escrow contract releases payment on completion.
Next.js 16 App Router on Vercel, Supabase off-chain, Solidity on Base Sepolia. `README.md` has the
product narrative.

**Status:** deployed on Sepolia, entire site behind a coming-soon gate. Dormant May–July 2026.

**Launch sequence — confirmed, do not reorder.** Prove everything possible on Sepolia (`CC-076`) →
migrate to Base mainnet and re-run the full lifecycle with Aaron's own funds (`CC-039`) → *then* the
gate lifts (`CC-014`). **The public's first look is on mainnet.** Finishing `CC-076` means "ready to
attempt the one-way migration", not "go public".

**The money path is half proven.** As of 2026-08-15 a worker has been paid on Sepolia by the v2
escrow, through a signed verdict, with no platform transaction anywhere in the path (`CC-082`).
Still broken, and all app-layer rather than contract: **`/api/fund-task` strands USDC** because
x402 pays the contract directly instead of calling `createTask` (`CC-081` Defect 1); the platform's
own `expireTaskOnChain` can never succeed (`CC-080` — `completeTaskOnChain` was removed there); and
`resolve_dispute` is still agent-only in the app layer, though the v2 contract no longer permits a
bare-assertion dispute (`CC-081` Defect 2). Nothing is lost, because the funding path has still never been run.

## Start here every session

1. **Read `docs/adr/README.md`.** Four accepted ADRs restructure the money path, the privacy posture,
   the monitoring scope and the public-claims policy. **ADR-0001 first — the others depend on it —
   and read its Amendment 1**, which supersedes several of its own decisions.
2. **Then the backlog.** It is the source of truth for what needs doing.
3. **Then `docs/Capability-Surface-Matrix.md`** before reporting any gap as a defect. Contract,
   scripts, app and MCP are deliberately **not** in lockstep — the matrix says which lag is the plan.
   Its three-bucket rule (published-and-wrong / one-way door / not built yet) is the triage test;
   anything that fits none of them is an opinion, not a finding.

```bash
cat docs/backlog/INDEX.md          # the board (generated)
node scripts/backlog.mjs           # regenerate after any change
node scripts/backlog.mjs --check   # verify INDEX.md is current
```

Issue files carry `file:line` references and acceptance criteria. Read the referenced code before
proposing a plan — and re-check a ticket's proposed *fix* against measurement, not just its problem
statement (`Lessons-Learned.md` §22).

**Closing the loop is part of the job.** Set `status: done`, bump `updated`, append what was actually
done and in which commit, run `node scripts/backlog.mjs`, reference the id in the commit message.
Never delete an issue file; use `wontfix` with a stated reason. Full convention:
`docs/backlog/README.md`.

**A design question gets an ADR, not a guess.** `CC-081` Defect 2 and `CC-075` are the worked
example — both sat open as "deliberately not specified" until `ADR-0001` answered them.

**Then ask whether it earned a `docs/Lessons-Learned.md` entry.** Transferable lessons only,
especially where something *masked* the defect. Not a changelog. Do not sanitise — the value is that
it is unflattering.

## Publish-by-default, with one exception

This repo is public **on purpose**, defects included (`CC-056`, `Lessons-Learned.md` §8). Defects are
published as found, with two carve-outs that are fixed *before* being described in a pushed commit:

1. anything exposing third-party data (`notification_channels` holds workers' contact addresses; the
   `waitlist` table is gone — dropped 2026-08-21, `CC-089`)
2. anything trivially exploitable against real funds

## Public claims — see ADR-0004

Two positions that keep getting re-litigated. Both settled. Read
`docs/adr/ADR-0004-public-claims-and-pseudonymity.md` before "fixing" any copy.

- **Site copy describes the target state, not today's build.** Nothing is live. Forward-looking copy
  is deliberate; do not correct it to match the build, and do not file it as a defect. The control is
  `CC-014`'s pre-flip checklist — if a claim outruns the build, add it there in the same commit.
  Still a real defect: a claim that will never be true, or a claim about a **third party** (`CC-029`).
- **Say "pseudonymous". Never "anonymous", never "zero PII".** The optional notification email is not
  identity verification and not a contradiction — ADR-0004 D4–D6. Never move a notification address
  onto the world-readable `humans` table.

## Hazards

Each entry is the operational fact and where the reasoning lives. **Verify with the command where one
exists rather than reasoning from this file.**

**Money path**

- **`/api/fund-task` takes no payment, and must never become an x402 recipient again.** It was
  one until `CC-081` Defect 1 (fixed 2026-08-21): an x402 settlement is a bare ERC-20 transfer, so
  paying it deposited USDC into `CarbonEscrow` without calling `createTask`, and the contract has no
  sweep, rescue or `receive`. Nothing was ever stranded because the path had never been run. It is
  now a **confirmation endpoint** — the agent funds from its own wallet via `USDC.approve` +
  `escrow.createTask`, then POSTs here, and the row only moves to `active` once `getTask(taskId)`
  reads `Funded` and matches on worker and amount. **The contract still has no rescue**, so the rule
  survives its cause: nothing may ever send USDC to the escrow except `createTask`.
  → `CC-081` Defect 1, `CC-037`
  · `node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs`
- **CarbonEscrow v2 is deployed** — `0xe80d03688E8fa6270668AD73191d353e522CB1b1` on Sepolia,
  block `45494043`, owned by the HSM key, verdict signer seeded. Implements `ADR-0001`:
  `submitWork`, pull-payment claims, EIP-712 verdicts. **The `TaskState` enum was renumbered** —
  `Completed` moved 2 → 3 and everything above `Funded` shifted, so any hard-coded state integer
  predating 2026-08-15 is wrong. → `CC-082`
  · `node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs`
- **`completeTaskOnChain` is gone (CC-080, done); `expireTaskOnChain` still cannot succeed.**
  `completeTask` is agent-only and the platform signer was structurally the wrong sender, so the
  function was removed outright — `confirm_task_completion` now records the confirmation and hands
  settlement back to the agent. `expireTask` is agent-only too (refunds are a pull-payment the
  agent claims, `A1.2`), so the remaining function reverts `NotAgent()` from the platform; it
  fails safely and its removal belongs with `CC-081` Defect 1. → `CC-080`, `ADR-0001` D2/A1.2
- **Dispute authority is decided; do not re-guess it.** Either party may dispute, but **only by
  presenting a signed failing verdict** — there is no bare-assertion dispute, because one would hand
  the agent both outcomes. `completeTask` stays agent-only: an agent may always choose to pay, never
  choose not to. **`resolve_dispute` was removed from MCP on 2026-08-26** — it authorised the hiring
  agent and executed with the owner key, so `onlyOwner` was notarising one interested party's ruling.
  "Agent resolves its own dispute" was explicitly rejected.
  **Arbitration now has no app or MCP surface at all**, deliberately: the owner resolves via
  `scripts/admin/verify-escrow-lifecycle.ts` with the KMS key until the adjudication tier exists.
  A disputed task therefore has no clock **yet**: `ADR-0006` D3 + Amendment 1 (2026-08-26) put a
  **fixed 7-day** arbitration window in the bytecode, running from `disputeTask` — **not** from
  `beginArbitration`, which is `onlyOwner` and optional, so a clock started there could be withheld
  forever by never calling it. An unresolved arbitration defaults to the **worker** via pull payment.
  It lands with `CC-034` or not at all for v1 — until it ships, a dispute can sit indefinitely and
  only the owner can end it.
  → `ADR-0001` D2, `ADR-0007` (proposed), `CC-081` Defect 2
- **Silence favoured the agent, and v2 inverts it.** v1 had one clock, so an agent that did nothing
  after delivery got refunded at expiry. v2 has two: the delivery deadline and an agent-set review
  window (12h–14d, bounded by the contract). Once `Delivered`, `expireTask` is unreachable and the
  worker claims via `releaseAfterReview`. → `ADR-0001` D1, `CC-082`
  · `npm run test:contracts`
- **The HSM key owns the contracts** — `0xa8931097540e69B474013D294d0bA6A2cC853e4b`. This entry has
  been wrong in **both** directions; never re-derive it by reading. → `CC-059`
  · `node --env-file=.env.local scripts/audit/verify-contract-owner.mjs`
  · **A redeploy resets ownership to the deployer — re-transfer it (`CC-082`).**
  · **Target is a 2-of-4 Safe before mainnet** (`ADR-0006` D2, accepted; `CC-090`, now P1), with the
    verdict signer split onto its own HSM key. Custody: Aaron two keys in two buildings, two family
    members one each — the two family keys reach threshold alone, which is what makes succession work
    without an estate finding anything. Cards are bought **separately**, so a shared seed is
    impossible by construction; the test is still on-chain — four owner addresses, no shared
    derivation.
- **The DB is not the authority on money.** Payout destinations come from the contract, never
  Supabase. Load-bearing for fund safety *and* the regulatory position. → `CC-037`, `CC-051`

**Data and RLS**

- **`tasks_public` bypasses RLS on purpose — do not "fix" it.** The view has no `security_invoker`, so
  it runs as its owner; that is the mechanism. Setting `security_invoker = true` silently breaks the
  public task feed. Its safety rests entirely on its explicit column list — **never `SELECT *`**, and
  re-check the list whenever a column is added to `tasks`. → migration 011, `CC-030`
- **Anything on `humans` is world-readable.** `humans_read_all` grants anon `SELECT` with
  `qual: true`, deliberately — it is the whitepages. Never put anything there that should not be
  public. → `CC-030`
- **"Anon denied" and "anon reads zero rows" are different, and it differs per table.** After
  migration `015`, `tasks`/`notification_channels`/`used_nonces`/`mcp_challenges` hard-deny
  with `401` + `42501` (`waitlist` was on this list until `CC-089` dropped it); `humans` and
  `tasks_public` keep anon `SELECT` by design. Anything written
  before 2026-08-11 describes the pre-revoke posture. **A newly added table inherits Supabase's
  default `GRANT ALL` — revoke it in the same migration.** → `CC-062`
  · `scripts/audit/inspect-live-schema.sql` block 4
- **`/api/*` bypasses the coming-soon gate.** Every API route is publicly reachable now. Treat them
  as live.
- **Never log PII.** `maskMeta` masks wallet addresses, not emails, and task payload must never reach
  a log line at all. → `CC-009`, `ADR-0002` D9

**Environment and config**

- **`ESCROW_DEPLOY_BLOCK` must be set** or event queries scan from genesis — ~36× the requests.
  Sepolia: **`45494043`**, and it moves with every redeploy — it was `39032720` until 2026-08-15,
  which is a valid block and therefore fails slowly rather than loudly. Not a `NEXT_PUBLIC_` var,
  so it takes effect at runtime.
  `RPC_MAX_BLOCK_RANGE` (default `10000`) is a *provider* property and has already moved once.
  → `CC-070` · `node --env-file=.env.local scripts/audit/find-deploy-block.mjs`
- **A blank env var is not an unset one, and Zod did not save us from it.** `VAR=`, a cleared Vercel
  field and an unset Actions secret all arrive as `""`. `??` misses it, `.default()` only fires on
  `undefined`, and **`z.coerce.number()` turns `""` into `0`, not `NaN`** — so a blank
  `RATE_LIMIT_MAX_REQUESTS` was a limit of zero in `config.ts` and `NaN` (no limiting at all) at the
  `parseInt` call sites. `config.ts` now maps blank to unset via `envInt`/`envOptional`; use those
  for any new var rather than reading `process.env` directly. → `CC-097`, `Lessons-Learned.md` §26
  · `grep -nE 'process\.env\.[A-Z_0-9]+\s*\?\?' -r src middleware.ts scripts`
- **`NEXT_PUBLIC_*` is inlined at build time.** Changing a Vercel env var does nothing without a
  fresh deploy. `NEXT_PUBLIC_COMING_SOON` fails closed — the value must be exactly `false`. → `CC-014`
- **Local Supabase credentials are asymmetric.** The anon key is valid; `SUPABASE_SERVICE_ROLE_KEY`
  is the literal placeholder. Anything needing the service role fails `401` locally — read the status
  codes, not a script's summary line.
- **KMS locally needs an *impersonated* ADC session, and it expires.** Plain
  `gcloud auth application-default login` cannot sign — the signing role sits on
  `kms-signer-svc`, and Aaron holds only `serviceAccountTokenCreator` scoped to it. A lapsed
  session fails as a 400 reading `unable to impersonate … "error_subtype":"invalid_rapt"`, which
  looks like broken config and is not. → `CC-059`
  · `gcloud auth application-default login --impersonate-service-account=kms-signer-svc@carbon-contractors.iam.gserviceaccount.com`

**Wallet and frontend**

- **The tested wallet path is not the shipped one.** With the Coinbase extension installed the
  `injected` connector can win, so the passkey Smart Wallet path — the one every mobile user takes —
  needs testing in a profile with **no extension**, picking `baseAccount` explicitly. → `CC-055`,
  `Lessons-Learned.md` §19
- **CSP failures are invisible when testing with an extension**, because it never touches the page's
  CSP. Test wallet flows on a deployed URL with the console open. → `CC-003`
- **Wallet addresses are lowercase in the DB and enforced.** Migration `014` backfilled and added a
  `CHECK (wallet = lower(wallet))`, so a mixed-case write now **errors** rather than silently
  mismatching. Normalise on both sides of any new query. → `CC-002`

**Git and tooling**

- **You cannot push to `master`.** Branch → PR → merge on GitHub. Two rulesets require verified
  signatures and code scanning; a direct push is rejected. "Push the commits" means this.
- **The commit identity is machine-specific, and must match the signing key's account.** Two
  identities are in use, one per machine, and they are not interchangeable:

  | Machine | Signing key | Commit as |
  | :-- | :-- | :-- |
  | Main PC | `sk-ssh-ed25519` (FIDO2) | `Aaron J Clifft <244833942+ajclifft@users.noreply.github.com>` |
  | Others | `ssh-ed25519` | `Aaron Clifft <35355423+Wahzammo@users.noreply.github.com>` |

  GitHub verifies a signature by resolving the **committer email** to an account, then looking for
  the key among *that* account's signing keys. Cross the pair and the commit is signed, pushes
  cleanly, and lands `Unverified` with reason `unknown_key` — measured 2026-08-26 on three commits
  carrying ajclifft's address and Wahzammo's key. Any `@users.noreply.github.com` address avoids
  `GH007`; the specific account is what decides verification. Check both before the first commit on
  a machine. → `CC-047`
- **Signing is always on; whether it needs a YubiKey touch is machine-specific.**
  `commit.gpgsign=true`, `gpg.format=ssh`. **Aaron's main PC signs with a FIDO2 key and a commit
  blocks until the key is physically touched** — an apparent hang is waiting for the tap, then fails
  `invalid format?`. Not a config error, retrying does not help, and `ssh-add -L` reporting no agent
  is a red herring. Other machines carry a plain `ssh-ed25519` key and sign with no interaction at
  all, so a hang *there* is a real fault rather than a missing tap. Check which before diagnosing —
  this entry asserted the touch unconditionally until 2026-08-26 and would have sent you looking for
  a key to press on a machine that has none.
  · `cut -d' ' -f1 "$(git config user.signingkey | sed "s|^~|$HOME|")"` — an `sk-` prefix
    (`sk-ssh-ed25519`) is FIDO2 and needs the touch; a bare `ssh-ed25519` does not
- **Signed is not the same as verified, and the two fail differently.** Local commits verify `G`;
  merge commits show `E` because GitHub's key is not in the local keyring — that is correct, not
  unsigned. Separately, GitHub marks a commit **Verified** only when the signing key and the
  committer email resolve to the *same* account, so a correctly signed commit still reads
  `Unverified` there when they do not. Measured 2026-08-26: signing with the `ajclifft` noreply
  address against a key registered elsewhere pushes fine (no `GH007`) and lands unverified.
- **A stacked PR blocks forever on CodeQL, and it looks like a slow check.** Code scanning is
  GitHub **default setup**, not a workflow file, so it only analyses PRs targeting the default
  branch. A PR based on another feature branch gets no analysis at all — and `master`'s ruleset
  requires `code_scanning` (tool `CodeQL`), so the check is *absent* rather than pending and never
  arrives. Merging the base does **not** fix it: retargeting changes the base without firing a
  `pull_request` event, so the head SHA is never analysed. Rebase onto the new `master` to change
  the head SHA, which triggers it. Measured 2026-08-26 on PR #143. Prefer branching each PR off
  `master`. `ci.yml`'s own trigger comment is the same lesson from the other direction.
  · `gh pr view <n> --json statusCheckRollup` — a *missing* CodeQL row is this, not a slow one
- **Line endings are pinned** (`* text=auto eol=lf`). If `git status` shows every file modified, that
  is the cause. **Python's `write_text` silently writes CRLF on Windows — use `write_bytes`.**
- **A fresh worktree has neither `node_modules` nor `.env.local`, and only `npm run build` says so.**
  Both are gitignored, so neither crosses into `.claude/worktrees/*`. Missing deps surface as
  `Cannot find module .../next/dist/bin/next` — run `npm ci` first. Missing env is the trap: because
  `src/lib/config.ts` validation is **lazy**, it does not fail at boot but at page-data collection,
  as `Invalid environment configuration: SUPABASE_URL …` against `/api/fund-task`. `dev`, `lint`,
  `typecheck` and `test` all pass without it, so build is the only step that trips and it reads as a
  code fault. Do not copy `.env.local` into the worktree; supply it for the one command. Node's
  `--env-file` does **not** work — Next propagates it into `NODE_OPTIONS` for its workers, which
  reject it `ERR_WORKER_INVALID_EXEC_ARGV`. → `CC-096`
  · `set -a; . ../../../.env.local; set +a; npm run build`
- **The test suite is hermetic by enforcement, not convention.** `vitest.setup.ts` strips every
  signing key, RPC URL and live contract address from the environment and blocks global `fetch`. A
  test that reaches the network fails loudly and logs `[CC-060 BLOCKED]`. If you need a real call, it
  belongs in `scripts/audit/`, not a unit test. `ALLOW_TEST_NETWORK=1` bypasses the guard locally —
  never in CI. → `CC-060`
- **There are two test suites and two typechecks; `npm test` is only half of each.** `npm test`
  (vitest) covers `src/`; `npm run test:contracts` (hardhat/mocha) covers `contracts/`. Likewise
  `npm run typecheck` covers the Next side and `npm run typecheck:contracts` covers
  `hardhat.config.ts`, `test/` and `scripts/deploy/`. CI runs all four. → `CC-082`
- **The ABIs in `src/lib/contracts/` are generated — do not hand-edit them.**
  `npm run compile && npm run gen:abi`. CI fails on drift via `npm run gen:abi -- --check`. A stale
  ABI is indistinguishable at runtime from a contract that lacks the function. → `CC-082`
- **`evmVersion` is pinned to `cancun`** in `hardhat.config.ts`. Solidity 0.8.24 defaults to
  `shanghai`, under which OpenZeppelin 5.6's `Bytes.sol` fails to compile (`mcopy`, EIP-5656). Base
  has had the Cancun opcodes since Ecotone, March 2024. → `CC-082`

## Where truth lives

| Question | Answer |
| :-- | :-- |
| Design decisions and rejected alternatives | `docs/adr/` — **read `README.md` first** |
| Addresses, deploy blocks, hashes, rule versions | `chain-constants.json` — a *record*, verify with the audit scripts it names |
| Continuity, custody, renewals, what breaks if it lapses | `docs/BCP-DR.md` |
| What needs doing | `docs/backlog/` |
| Product narrative, MCP tool list, stack | `README.md` |
| Security findings AUD-001..010 | `AUDIT-2026-03-25.md` |
| Signer / HSM architecture | `docs/HSM-Deployer-Checklist.md`, `docs/Security-Trust-Disclosure.md` |
| Key-compromise recovery | `docs/Key-Compromise-Recovery.md` |
| Architecture overview, MVP definition of done | `docs/Linear-Document-Archive.md` |
| Pre-July-2026 issue history | `docs/carbon_contractors_full_export.md` |
| What went wrong and what fixed it | `docs/Lessons-Learned.md` |
| Live health | `/api/health` — database, escrow contract, session status |

**This file goes stale faster than anything else in the repo.** An audit on 2026-08-13 found five
wrong claims in it — a migration range, a test count, a fixed-issue warning, an obsolete branch note,
and a signing status that had been wrong for weeks. Prefer a pointer over a paragraph, and a command
over a claim.

Linear was retired in July 2026. `NOR-xxx` in code comments maps to `CC-xxx` via the `linear:`
frontmatter field.

## Layout

```
src/app/api/           REST + MCP routes. basedhuman.mcp/ is the MCP server entry point.
src/app/               Pages: / /connect /dashboard /services /learn /mcp-info
src/learn/             The 7 Learn modules (markdown); registry in src/lib/learn/modules.ts
src/lib/mcp/server.ts  All 10 MCP tools and 3 resources (resolve_dispute removed, ADR-0001 D2)
src/lib/db/            Supabase access. whitepages.ts reads with the ANON key;
                       register/notifications use the SERVICE ROLE key. Know which you are in.
src/lib/contracts/     signer.ts (KMS or raw key), kms-signer.ts, escrow.ts (read-only), ABIs
src/lib/config.ts      Zod env schema. Validation is LAZY — missing vars surface as 500s at
                       request time, not as a boot failure.
src/lib/categories.ts  The 10 service categories, max 2 per worker
contracts/             CarbonEscrow.sol (v2, CC-082), ReputationStake.sol
                       mocks/ is test-only — never deployed to a live network
test/                  Hardhat/mocha contract tests. `npm run test:contracts`
supabase/migrations/   001-020, applied by hand in order. Add new ones, never edit an applied one.
                       No migration runner — **`ls` the directory for the next number** (CC-057).
                       There are already two 018s (funded_at, offer_lifecycle) — order-independent
                       by luck, not design. Trusting a range written here is what produced the
                       duplicate 014 in August 2026, and then these.
scripts/audit/         Read-only verification scripts. Run these instead of trusting this file.
```

## Commands

```bash
npm run dev              # Next dev server
npm test                 # Vitest, src/ only. Hermetic — vitest.setup.ts blocks the network (CC-060)
npm run test:contracts   # Hardhat/mocha, contracts/ only (CC-082)
npm run typecheck        # tsc --noEmit, Next side
npm run typecheck:contracts   # tsc -p tsconfig.hardhat.json — hardhat.config, test/, scripts/deploy/
npm run lint
npm run build
npm run compile          # Hardhat compile
npm run gen:abi          # Regenerate src/lib/contracts/*-abi.ts from artifacts (CC-082)
npm run monitors         # Run every invariant monitor against the LIVE chain (CC-085)
npm run monitors:list    # Offline — validates the monitor registry. Runs in CI
npm run seed             # Seeds demo workers into Supabase (fixed in CC-017; needs real env)
```

CI runs `npm ci`, `npm audit --audit-level=high`, lint, typecheck, compile, `typecheck:contracts`,
the ABI drift check, `test:contracts`, `monitors:list`, test, build. The audit step fails the build
on high-severity findings, so a stale dependency tree breaks CI rather than merging quietly.

**The invariant monitors run on a schedule, not in CI** — `.github/workflows/monitors.yml`, hourly.
They read the live chain, so no `pull_request` trigger may ever run them. Alerting has two paths and
**path 2 is not live until `MONITOR_WEBHOOK_URL` and `MONITOR_HEARTBEAT_URL` are set as repository
secrets**; without the heartbeat, the schedule silently stopping is indistinguishable from
everything passing. → `CC-085`, `ADR-0003` D3/D5

## Conventions

- **Commits:** conventional, with the issue id — `fix(connect): show wallet button on mobile (CC-001)`, so `git log --grep=CC-001` reconstructs the story.
- **Zod everywhere** on external input: API route bodies, MCP tool arguments, env vars.
- **Migrations are append-only.** New file, next number, never edit an applied one. **Check the directory for the next number** — there is no runner, and a duplicate `014` was created in August 2026 by trusting this file's stale range instead.
- **Australian English** in user-facing copy. The codebase mixes `-ise`/`-ize`; match the file you are in.

## Do not

- **Do not commit secrets.** `.env.local` is gitignored and has never been in history. **This repo is public** — assume anything committed is world-readable, including backlog files and docs. Intentional for defects and reasoning; never acceptable for keys, tokens, Supabase project refs, or anything from `.env.local`.
- Do not sanitise `docs/Lessons-Learned.md` into a highlight reel.
- Do not edit `docs/backlog/INDEX.md` by hand; it is generated.
- Do not assume a fix works because it works locally — the CSP, the coming-soon gate and the wallet connector all behave differently in production.
- Do not trust inherited checkboxes in the archived MVP definition of done or the old go-live gate; several were stale when Linear was retired. Re-derive from the code.

## Tracked work items
- Do not create or edit files under docs/backlog/CC-*.md without explicit approval.
- When you notice a problem outside the current task's scope, log it in a single line under "Observations" in your response instead — don't file it as a ticket.
- I'll decide what gets promoted to a CC-### issue.
- **Enforced, partly.** `.claude/hooks/check-backlog.ps1` is registered as a `PreToolUse`
  hook on `Write|Edit` (`.claude/settings.json`) and denies a write to any
  `docs/backlog/CC-###.md`. Verified firing 2026-08-26.
  **It does not cover a write driven through `Bash`** — a shell command carries no
  `file_path`, and the matcher does not include `Bash`, so a script that edits a ticket
  sidesteps it entirely. Widening the matcher would be theatre: the path usually lives
  inside the script, not in the command string. Treat the rule above as the control and
  the hook as a backstop for the common case.
