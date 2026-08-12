# CLAUDE.md

Orientation for Claude sessions on this repo. Read this first, then the specific backlog issues
you have been asked to work on.

## What this is

Carbon Contractors — a Human-as-a-Service marketplace on Base. AI agents discover human workers
over MCP, fund tasks with USDC through x402, and the escrow contract releases payment on
completion. Next.js 16 App Router on Vercel, Supabase for off-chain state, Solidity on Base
Sepolia. See `README.md` for the product narrative.

**Status as of August 2026:** deployed and running on Sepolia, but the whole site sits behind a
coming-soon gate. The project was dormant from May to July 2026.

**Launch sequence (confirmed 2026-08-10, do not reorder):** build and test everything possible
on Sepolia first (`docs/backlog/CC-076.md`) → migrate to Base mainnet and re-run the full
lifecycle with Aaron's own real funds (`docs/backlog/CC-039.md`) → only once that mainnet re-test
is clean does the coming-soon gate lift for the public (`docs/backlog/CC-014.md`, the literal
last gate). The public's first look at the site happens on mainnet, not on Sepolia — "finish the
Sepolia checklist" does not mean "go public," it means "ready to attempt the one-way mainnet
migration." Do not treat opening the coming-soon gate as a testnet milestone.

## Start here every session

**If `docs/CURRENT-STATE.md` exists, read it first.** It is a point-in-time handover: what has been
verified against the live system, what is still unknown, and the current task queue in order. It is
deliberately temporary — delete it once its queue is cleared, rather than letting it rot into a
second, contradictory source of truth.


The backlog is the source of truth for what needs doing:

```bash
cat docs/backlog/INDEX.md          # the board
cat docs/backlog/CC-001.md         # a specific issue
node scripts/backlog.mjs           # regenerate INDEX.md after any change
node scripts/backlog.mjs --check   # verify INDEX.md is current
```

Issue files carry `file:line` references and acceptance criteria — they are the handoff document,
written so a fresh session can start without re-deriving context. Read the referenced code before
proposing a plan.

**Closing the loop is part of the job.** When you finish work on an issue: set `status: done`,
bump `updated`, append a short note recording what was actually done and in which commit, run
`node scripts/backlog.mjs`, and reference the issue id in the commit message. Never delete an
issue file. Use `status: wontfix` with a stated reason for deliberate non-work.
`docs/backlog/README.md` has the full convention.

**Then ask whether it earned a lessons-learned entry.** `docs/Lessons-Learned.md` is a public,
deliberate trust artefact — the argument being that for an unknown solo developer building an
escrow service, demonstrated self-scrutiny is worth more than a clean README. It is not a
changelog. Add an entry when a fix carries a *transferable* lesson, especially when the defect
survived because something masked it. Skip it for routine work. Each entry: what was wrong, why it
survived review, what fixed it, the lesson. Write plainly, including where it is unflattering —
sanitised entries defeat the point.

## Publish-by-default, with one exception

This repo is public **on purpose**, defects included. See `CC-056` and `Lessons-Learned.md` §8.

Defects are published as found, with two exceptions, which are fixed *before* being described in
a pushed commit:

1. anything exposing third-party data (the `waitlist` table holds real email addresses)
2. anything trivially exploitable against real funds

Everything else is published immediately, unfixed, with the reasoning intact. If you are about to
write an issue or a lessons entry that hands a reader a working exploit against someone other than
the operator, fix it first, then write it up as found-and-fixed.

## Landmines

These cost real time to discover. Do not rediscover them.

**The tested wallet path is not the shipped wallet path.** All historical testing used the
Coinbase Wallet browser extension — a seed-phrase EOA that injects `window.ethereum`. As of CC-043,
`src/lib/wallet/providers.tsx` has an explicit `createConfig` with an explicit connector list
(`baseAccount`, `injected`) instead of inheriting OnchainKit's undocumented default — but the
underlying fact this landmine warns about is unchanged: with the extension installed, the
`injected` connector wins if a user (or a NavBar dropdown) picks it, so the passkey Smart Wallet
flow — the one every mobile user must take, and the one the product pitch is built on — still has
never been executed end-to-end. Verify wallet changes in a profile with **no extension
installed**, and pick the `baseAccount` connector explicitly when testing. See CC-055.

**CSP failures are invisible when testing with an extension.** The extension signs in its own
popup and proxies RPC through its background context, so it never touches the page's CSP.
`next.config.ts` currently has no `frame-src` directive at all and an incomplete `connect-src`.
Test wallet flows on a deployed URL with the console open, not locally. See CC-003.

**Wallet addresses are stored inconsistently.** Registration writes the checksummed mixed-case
address; lookups query `.toLowerCase()`. `humans.wallet` is case-sensitive `TEXT UNIQUE`. Until
CC-002 lands, profile lookups fail for every registered worker. Normalise to lowercase on both
sides of any new query you write.

**`NEXT_PUBLIC_*` is inlined at build time.** `middleware.ts` and `src/app/page.tsx` both read
`NEXT_PUBLIC_COMING_SOON` at module scope, and `/` is statically prerendered. Changing the Vercel
env var does nothing without a fresh deploy. The flag fails closed — the value must be exactly
the string `false`. See CC-014.

**`/api/*` is not behind the coming-soon gate.** `middleware.ts` bypasses it, so every API route
is publicly reachable right now even though the site looks dark. Treat API routes as live.

**The HSM key owns the contracts. This entry has now been wrong in both directions — do not guess
it a third time.** `CarbonEscrow.owner()` and `ReputationStake.owner()` are
`0xa8931097540e69B474013D294d0bA6A2cC853e4b`, the KMS/HSM address. CC-059 called
`transferOwnership()` on 2026-07-30 and it was confirmed by an independent Basescan read of tx
`0x08cd2e3…`, which also shows the HSM address as the sender of a real 1 USDC dispute resolution —
so the KMS signer demonstrably works against the live contracts.

The history, because this keeps flipping: the entry first guessed the HSM key was the owner; the
2026-07-30 measurement found the raw `DEPLOYER_PRIVATE_KEY` address
`0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b` was, and the entry was rewritten to say so; then
CC-059 actually performed the transfer, which made that rewrite stale within the same session. The
raw key is no longer the owner.

Consequence: production (KMS) signs as the owner and `resolveDisputeOnChain` works there. A **local**
run using `DEPLOYER_PRIVATE_KEY` is now the one that reverts on owner-only functions, which is the
opposite of what it was. `docs/Security-Trust-Disclosure.md`'s public claim that the HSM key owns the
escrow is now true. Never re-derive this by reading — run
`node --env-file=.env.local scripts/audit/verify-contract-owner.mjs`.

**`completeTaskOnChain` cannot work, and it is a design contradiction rather than a key problem.**
`CarbonEscrow.completeTask` requires `msg.sender == task.agent`
(`contracts/CarbonEscrow.sol:128`, confirmed present in the deployed bytecode), and
`createTask` sets `agent: msg.sender` (`:107`). Nothing server-side calls the contract's
`createTask` — the agent funds the escrow from its own wallet, so `task.agent` is the *agent's*
address, while `signer.ts:102` calls `completeTask` as the platform signer. So
`confirm_task_completion` (`src/lib/mcp/server.ts:391`) reverts with `"only agent"` on every task,
and always has: **the core hire→pay loop has never worked.** It fails safely — the handler returns
`isError` without flipping the DB to `completed`, so no worker was ever falsely marked paid. Aaron's
ruling is that agent-signed completion is the intended design, so the fix is app-side with no
redeploy. See CC-080 (the fix) and CC-037 (the verification).

**`tasks_public` bypasses RLS on purpose — do not "fix" it.** `tasks` has RLS enabled with zero
policies, so anon is denied. Anon reads the `tasks_public` view instead, which excludes
`task_description` by an explicit column list (migration 011). The view has **no**
`security_invoker`, so it runs as its owner and bypasses the `tasks` RLS — that is the intended
mechanism. A security pass that spots this and sets `security_invoker = true` will silently break
the public task feed, because the view would then hit the deny-all policy set. Leave it off. The
safety of this arrangement rests entirely on the view's column list, so **never change it to
`SELECT *`**, and check the list whenever a column is added to `tasks`.

**Anything added to the `humans` table is public.** The `humans_read_all` policy grants anon
`SELECT` with `qual: true` — deliberate, it is the whitepages (CC-030). The `human_whitepages` MCP
resource has a field allowlist, but that does not protect direct anon queries against the table.
Never put anything on `humans` that should not be world-readable.

**"Anon is denied" and "anon reads zero rows" are different things.** `waitlist`, `tasks`,
`notification_channels`, `used_nonces` and `mcp_challenges` return **HTTP 200 with an empty array**
to the anon key, not a 403. Anon holds the table-level `SELECT` grant (Supabase grants it by
default); RLS alone filters the rows. So RLS is singly load-bearing over real email addresses — one
`DISABLE ROW LEVEL SECURITY` or one over-broad policy exposes them with no second barrier. See
CC-062. When reading audit notes, treat "denied" claims as "returned no rows" unless a
`has_table_privilege` result is quoted.

**Local Supabase credentials are asymmetric.** `.env.local` has a valid anon key but the
`SUPABASE_SERVICE_ROLE_KEY` is the literal placeholder `placeholder…`. Anything needing the service
role — the OpenAPI spec endpoint, `pg_catalog` queries, server-side write paths — fails with
`401 Invalid API key` locally. Scripts that probe with both keys will report the service-role half as
"not found" when it is actually "not authenticated"; read the status codes, not the summary line.

**Line endings are pinned.** `.gitattributes` sets `* text=auto eol=lf`, and the repo has
`core.autocrlf=false`, `core.eol=lf`. A Windows checkout without these produces a phantom
whole-tree diff. If `git status` shows every file modified, that is the cause, not your changes.

**You cannot push directly to `master`. Branch and open a PR.** Two active rulesets target
`~DEFAULT_BRANCH`: `protect_main_branch` (`required_signatures`, `code_scanning`, `code_quality`,
`deletion`, `non_fast_forward`) and a Copilot review requirement. Unsigned commits are rejected with
`GH013`, and the code-scanning rule cannot be satisfied by a direct push at all. Every commit in
`master`'s history arrived via a PR merge. Feature branches are unrestricted, so the working flow is
branch → PR → merge on GitHub. Instructions anywhere in the docs to "push the commits" mean this.

**Commit with the noreply email or the push is rejected.** Pushed history uses
`244833942+ajclifft@users.noreply.github.com`. A real address triggers `GH007` ("your push would
publish a private email address") because the repo is public — correctly, so do not work around it by
changing the GitHub setting. Check `git config user.email` before committing; a fresh clone or a new
machine will default to something else. Commit signing is not currently configured (`commit.gpgsign`
unset, and `%G?` reports `N` on recent commits), which is why signatures have to come from GitHub's
own merge commit. See CC-047.

**One unmerged branch has real work on it.** `origin/claude/nor-195-recovery-runbook`
(commit `8df1c7f`) contains a completed key-compromise recovery runbook that was never merged.
Cherry-pick the file; do not merge the branch, as it predates the current tree and a merge looks
like it deletes the backlog. See CC-049.

## Where truth lives

| Question | Answer |
| :-- | :-- |
| What needs doing | `docs/backlog/` |
| Product narrative, MCP tool list, stack | `README.md` |
| Security findings AUD-001..010 | `AUDIT-2026-03-25.md` |
| Signer / HSM architecture | `docs/HSM-Deployer-Checklist.md`, `docs/Security-Trust-Disclosure.md` |
| Architecture overview, MVP definition of done | `docs/Linear-Document-Archive.md` |
| Pre-July-2026 issue history | `docs/carbon_contractors_full_export.md` |
| What went wrong and what fixed it | `docs/Lessons-Learned.md` |
| Live health | `/api/health` — reports database, escrow contract and session status |

Linear was retired in July 2026. `NOR-xxx` references in code comments map to `CC-xxx` issues via
the `linear:` frontmatter field.

## Layout

```
src/app/api/           REST + MCP routes. basedhuman.mcp/ is the MCP server entry point.
src/app/               Pages: / /connect /dashboard /services /learn /mcp-info
src/lib/mcp/server.ts  All 10 MCP tools and 3 resources
src/lib/db/            Supabase access. whitepages.ts reads with the ANON key;
                       register/notifications use the SERVICE ROLE key. Know which you are in.
src/lib/contracts/     signer.ts (KMS or raw key), kms-signer.ts, escrow.ts (read-only), ABIs
src/lib/config.ts      Zod env schema. Validation is LAZY — missing vars surface as 500s at
                       request time, not as a boot failure.
src/lib/categories.ts  The 10 service categories, max 2 per worker
contracts/             CarbonEscrow.sol, ReputationStake.sol
supabase/migrations/   001-011, applied in order. Add new ones, never edit old ones.
```

## Commands

```bash
npm run dev            # Next dev server
npm test               # Vitest (116 tests — and see CC-060: not hermetic, so it is flaky)
npm run typecheck      # tsc --noEmit
npm run lint
npm run build
npm run compile        # Hardhat compile
npm run seed           # BROKEN — still writes the pre-migration-008 `skills` column (CC-017)
```

CI runs `npm ci`, `npm audit --audit-level=high`, lint, typecheck, test, build. The audit step
fails the build on high-severity findings, so a stale dependency tree breaks CI rather than
merging quietly.

## Conventions

- **Commits:** conventional commits with the issue id — `fix(connect): show wallet button on mobile (CC-001)`. This makes `git log --grep=CC-001` reconstruct the story.
- **Zod everywhere** on external input: API route bodies, MCP tool arguments, env vars.
- **Never log PII.** `src/lib/logging.ts` masks wallet addresses via `maskMeta`, but not emails — see CC-009. Check before adding a log line.
- **Migrations are append-only.** New file, next number, never edit an applied one.
- **The DB is not the authority on money.** On-chain escrow state is. Any payout destination must come from the contract, never from Supabase. This property is load-bearing for both fund safety and the regulatory position in CC-051 — see CC-037.
- **Australian English** in user-facing copy. Note the codebase mixes `-ise`/`-ize`; match the file you are in.

## Do not

- **Do not commit secrets.** `.env.local` is gitignored and has never been in history. Keep it that way. **This repo is public** — assume anything committed is world-readable, including backlog files and docs. That is intentional for defects and reasoning; it is never acceptable for keys, tokens, Supabase project refs or anything from `.env.local`.
- Do not sanitise `docs/Lessons-Learned.md` into a highlight reel. Its value is that it is unflattering.
- Do not edit `docs/backlog/INDEX.md` by hand; it is generated.
- Do not add a `NEXT_PUBLIC_` var expecting a runtime change to take effect without a redeploy.
- Do not assume a fix works because it works locally — the CSP, the coming-soon gate and the wallet connector all behave differently in production.
- Do not trust the inherited checkboxes in the archived MVP definition of done or the old go-live gate; several were stale when Linear was retired. Re-derive status from the code.
