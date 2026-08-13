# CLAUDE.md

Orientation for Claude sessions on this repo. This file is a **fast index of hazards and pointers**,
not the reasoning itself — the reasoning lives in `docs/adr/`, `docs/backlog/` and
`docs/Lessons-Learned.md`, where it can be read on demand. Keep entries here short; long prose here
goes stale silently, and has (see §*Where truth lives*).

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

**No part of the money path works end to end yet.** Funding strands USDC, settlement reverts,
disputes are self-resolved. Nothing is lost because none of it has ever run. `CC-080`, `CC-081`,
`CC-082`.

## Start here every session

1. **Read `docs/adr/README.md`.** Four accepted ADRs restructure the money path, the privacy posture,
   the monitoring scope and the public-claims policy. **ADR-0001 first — the others depend on it —
   and read its Amendment 1**, which supersedes several of its own decisions.
2. **Then the backlog.** It is the source of truth for what needs doing.

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

1. anything exposing third-party data (the `waitlist` table holds real email addresses until `CC-089`)
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

- **`/api/fund-task` strands USDC permanently — do not run the funding path.** x402 pays
  `NEXT_PUBLIC_ESCROW_CONTRACT` as a bare ERC-20 transfer, so `createTask` never runs and the
  contract has no sweep, rescue or `receive`. Measured 2026-08-11: nothing stranded, because it has
  never been run. First real use loses the money. → `CC-081` Defect 1, `CC-037`
  · `node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs`
- **`completeTaskOnChain` can never succeed.** `completeTask` requires `msg.sender == task.agent` and
  `createTask` sets `agent: msg.sender`, so the platform signer is structurally the wrong sender.
  Fails safely — returns `isError` without flipping the DB. → `CC-080`, `ADR-0001` D2
- **Dispute authority is decided; do not re-guess it.** `dispute_task` and `resolve_dispute` are both
  agent-only today, which lets an agent refund itself after delivery. `ADR-0001` D2 fixes it:
  either party disputes, `resolve_dispute` loses agent authority, `completeTask` stays agent-only.
  "Agent resolves its own dispute" was explicitly rejected. → `ADR-0001` D2, `CC-081` Defect 2
- **Silence favours the agent.** `CarbonEscrow` has one clock, so an agent that simply does nothing
  after delivery gets refunded at expiry. Fixed by `submitWork` + review window. → `ADR-0001` D1,
  `CC-082`
- **The HSM key owns the contracts** — `0xa8931097540e69B474013D294d0bA6A2cC853e4b`. This entry has
  been wrong in **both** directions; never re-derive it by reading. → `CC-059`
  · `node --env-file=.env.local scripts/audit/verify-contract-owner.mjs`
  · **A redeploy resets ownership to the deployer — re-transfer it (`CC-082`).**
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
  migration `015`, `waitlist`/`tasks`/`notification_channels`/`used_nonces`/`mcp_challenges` hard-deny
  with `401` + `42501`; `humans` and `tasks_public` keep anon `SELECT` by design. Anything written
  before 2026-08-11 describes the pre-revoke posture. **A newly added table inherits Supabase's
  default `GRANT ALL` — revoke it in the same migration.** → `CC-062`
  · `scripts/audit/inspect-live-schema.sql` block 4
- **`/api/*` bypasses the coming-soon gate.** Every API route is publicly reachable now. Treat them
  as live.
- **Never log PII.** `maskMeta` masks wallet addresses, not emails, and task payload must never reach
  a log line at all. → `CC-009`, `ADR-0002` D9

**Environment and config**

- **`ESCROW_DEPLOY_BLOCK` must be set** or event queries scan from genesis — ~36× the requests.
  Sepolia: `39032720`. Not a `NEXT_PUBLIC_` var, so it takes effect at runtime.
  `RPC_MAX_BLOCK_RANGE` (default `10000`) is a *provider* property and has already moved once.
  → `CC-070` · `node --env-file=.env.local scripts/audit/find-deploy-block.mjs`
- **`NEXT_PUBLIC_*` is inlined at build time.** Changing a Vercel env var does nothing without a
  fresh deploy. `NEXT_PUBLIC_COMING_SOON` fails closed — the value must be exactly `false`. → `CC-014`
- **Local Supabase credentials are asymmetric.** The anon key is valid; `SUPABASE_SERVICE_ROLE_KEY`
  is the literal placeholder. Anything needing the service role fails `401` locally — read the status
  codes, not a script's summary line.

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
- **Commit with the noreply email** `244833942+ajclifft@users.noreply.github.com` or the push fails
  `GH007`. Check `git config user.email` first. → `CC-047`
- **Signing needs a physical YubiKey touch.** `commit.gpgsign=true`, `gpg.format=ssh`, FIDO2 key. A
  commit that appears to hang is waiting for the touch, then fails `invalid format?`. Not a config
  error; retrying does not help. `ssh-add -L` reporting no agent is a red herring. Local commits
  verify `G`; merge commits show `E` because GitHub's key is not in the local keyring — that is
  correct, not unsigned.
- **Line endings are pinned** (`* text=auto eol=lf`). If `git status` shows every file modified, that
  is the cause. **Python's `write_text` silently writes CRLF on Windows — use `write_bytes`.**
- **`npm test` is not hermetic** — it broadcasts real Sepolia transactions and is measurably flaky
  (10 then 13 failures observed on unchanged trees, each followed by a clean run). Re-run before
  investigating a failure, and do not treat "tests pass" as evidence during launch validation.
  → `CC-060`

## Where truth lives

| Question | Answer |
| :-- | :-- |
| Design decisions and rejected alternatives | `docs/adr/` — **read `README.md` first** |
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
src/lib/mcp/server.ts  All 10 MCP tools and 3 resources
src/lib/db/            Supabase access. whitepages.ts reads with the ANON key;
                       register/notifications use the SERVICE ROLE key. Know which you are in.
src/lib/contracts/     signer.ts (KMS or raw key), kms-signer.ts, escrow.ts (read-only), ABIs
src/lib/config.ts      Zod env schema. Validation is LAZY — missing vars surface as 500s at
                       request time, not as a boot failure.
src/lib/categories.ts  The 10 service categories, max 2 per worker
contracts/             CarbonEscrow.sol, ReputationStake.sol
supabase/migrations/   001-015, applied by hand in order. Add new ones, never edit an applied one.
                       No migration runner — check the directory for the next number (CC-057).
scripts/audit/         Read-only verification scripts. Run these instead of trusting this file.
```

## Commands

```bash
npm run dev            # Next dev server
npm test               # Vitest — 128 tests, and see CC-060: not hermetic, so it is flaky
npm run typecheck      # tsc --noEmit
npm run lint
npm run build
npm run compile        # Hardhat compile
npm run seed           # BROKEN — still writes the pre-migration-008 `skills` column (CC-017)
```

CI runs `npm ci`, `npm audit --audit-level=high`, lint, typecheck, test, build. The audit step fails
the build on high-severity findings, so a stale dependency tree breaks CI rather than merging quietly.

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
