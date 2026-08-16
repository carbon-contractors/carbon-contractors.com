# CLAUDE.md

Orientation for Claude sessions on this repo. This file is a **fast index of hazards and pointers**,
not the reasoning itself â€” the reasoning lives in `docs/adr/`, `docs/backlog/` and
`docs/Lessons-Learned.md`, where it can be read on demand. Keep entries here short; long prose here
goes stale silently, and has (see Â§*Where truth lives*).

## Who owns what

**Claude is Lead Dev. Aaron is Product Manager.**

So product decisions â€” launch sequencing, priorities, what gets claimed publicly, what is out of
scope â€” are Aaron's. They appear in this file because the Lead Dev needs to know them, not because
the Lead Dev owns them. Where one is recorded here or in an ADR, implement it; don't re-litigate it
or quietly "fix" it (`CC-081` Defect 2 and `CC-075` are the worked example of what re-deriving a
settled decision costs). Raise a concern once, then build.

Engineering calls â€” architecture, mechanism, sequencing of the work itself â€” are Claude's to propose
and Aaron's to veto.

**We are building and discovering this together, so some drift in this file is expected.** It is not
a spec handed down; it is a shared working note that trails slightly behind what we have just learned.
If you find something stale, correct it and carry on â€” that is maintenance, not a finding.

## What this is

Carbon Contractors â€” a Human-as-a-Service marketplace on Base. AI agents discover human workers over
MCP, fund tasks with USDC through x402, and the escrow contract releases payment on completion.
Next.js 16 App Router on Vercel, Supabase off-chain, Solidity on Base Sepolia. `README.md` has the
product narrative.

**Status:** deployed on Sepolia, entire site behind a coming-soon gate. Dormant Mayâ€“July 2026.

**Launch sequence â€” confirmed, do not reorder.** Prove everything possible on Sepolia (`CC-076`) â†’
migrate to Base mainnet and re-run the full lifecycle with Aaron's own funds (`CC-039`) â†’ *then* the
gate lifts (`CC-014`). **The public's first look is on mainnet.** Finishing `CC-076` means "ready to
attempt the one-way migration", not "go public".

**The money path is half proven.** As of 2026-08-15 a worker has been paid on Sepolia by the v2
escrow, through a signed verdict, with no platform transaction anywhere in the path (`CC-082`).
Still broken, and all app-layer rather than contract: **`/api/fund-task` strands USDC** because
x402 pays the contract directly instead of calling `createTask` (`CC-081` Defect 1); the platform's
own `completeTaskOnChain` and `expireTaskOnChain` can never succeed (`CC-080`); and `resolve_dispute`
is still agent-only in the app layer, though the v2 contract no longer permits a bare-assertion
dispute (`CC-081` Defect 2). Nothing is lost, because the funding path has still never been run.

## Start here every session

1. **Read `docs/adr/README.md`.** Four accepted ADRs restructure the money path, the privacy posture,
   the monitoring scope and the public-claims policy. **ADR-0001 first â€” the others depend on it â€”
   and read its Amendment 1**, which supersedes several of its own decisions.
2. **Then the backlog.** It is the source of truth for what needs doing.

```bash
cat docs/backlog/INDEX.md          # the board (generated)
node scripts/backlog.mjs           # regenerate after any change
node scripts/backlog.mjs --check   # verify INDEX.md is current
```

Issue files carry `file:line` references and acceptance criteria. Read the referenced code before
proposing a plan â€” and re-check a ticket's proposed *fix* against measurement, not just its problem
statement (`Lessons-Learned.md` Â§22).

**Closing the loop is part of the job.** Set `status: done`, bump `updated`, append what was actually
done and in which commit, run `node scripts/backlog.mjs`, reference the id in the commit message.
Never delete an issue file; use `wontfix` with a stated reason. Full convention:
`docs/backlog/README.md`.

**A design question gets an ADR, not a guess.** `CC-081` Defect 2 and `CC-075` are the worked
example â€” both sat open as "deliberately not specified" until `ADR-0001` answered them.

**Then ask whether it earned a `docs/Lessons-Learned.md` entry.** Transferable lessons only,
especially where something *masked* the defect. Not a changelog. Do not sanitise â€” the value is that
it is unflattering.

## Publish-by-default, with one exception

This repo is public **on purpose**, defects included (`CC-056`, `Lessons-Learned.md` Â§8). Defects are
published as found, with two carve-outs that are fixed *before* being described in a pushed commit:

1. anything exposing third-party data (the `waitlist` table holds real email addresses until `CC-089`)
2. anything trivially exploitable against real funds

## Public claims â€” see ADR-0004

Two positions that keep getting re-litigated. Both settled. Read
`docs/adr/ADR-0004-public-claims-and-pseudonymity.md` before "fixing" any copy.

- **Site copy describes the target state, not today's build.** Nothing is live. Forward-looking copy
  is deliberate; do not correct it to match the build, and do not file it as a defect. The control is
  `CC-014`'s pre-flip checklist â€” if a claim outruns the build, add it there in the same commit.
  Still a real defect: a claim that will never be true, or a claim about a **third party** (`CC-029`).
- **Say "pseudonymous". Never "anonymous", never "zero PII".** The optional notification email is not
  identity verification and not a contradiction â€” ADR-0004 D4â€“D6. Never move a notification address
  onto the world-readable `humans` table.

## Hazards

Each entry is the operational fact and where the reasoning lives. **Verify with the command where one
exists rather than reasoning from this file.**

**Money path**

- **`/api/fund-task` strands USDC permanently â€” do not run the funding path.** x402 pays
  `NEXT_PUBLIC_ESCROW_CONTRACT` as a bare ERC-20 transfer, so `createTask` never runs and the
  contract has no sweep, rescue or `receive`. Measured 2026-08-11: nothing stranded, because it has
  never been run. First real use loses the money. â†’ `CC-081` Defect 1, `CC-037`
  Â· `node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs`
- **CarbonEscrow v2 is deployed** â€” `0xe80d03688E8fa6270668AD73191d353e522CB1b1` on Sepolia,
  block `45494043`, owned by the HSM key, verdict signer seeded. Implements `ADR-0001`:
  `submitWork`, pull-payment claims, EIP-712 verdicts. **The `TaskState` enum was renumbered** â€”
  `Completed` moved 2 â†’ 3 and everything above `Funded` shifted, so any hard-coded state integer
  predating 2026-08-15 is wrong. â†’ `CC-082`
  Â· `node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs`
- **`completeTaskOnChain` can never succeed, and `expireTaskOnChain` no longer can either.**
  `completeTask` is agent-only and the platform signer is structurally the wrong sender (`CC-080`).
  v2 made `expireTask` agent-only too â€” refunds are a pull-payment the agent claims (`A1.2`) â€” so
  that function reverts `NotAgent()` from the platform as well. Both fail safely. Removal belongs
  with `CC-081` Defect 1. â†’ `CC-080`, `ADR-0001` D2/A1.2
- **Dispute authority is decided; do not re-guess it.** `dispute_task` and `resolve_dispute` are both
  agent-only in the *app layer* today, which lets an agent refund itself after delivery. v2's
  contract already fixes the on-chain half: either party may dispute, but **only by presenting a
  signed failing verdict** â€” there is no bare-assertion dispute, because one would hand the agent
  both outcomes again. `resolve_dispute` loses agent authority; `completeTask` stays agent-only.
  "Agent resolves its own dispute" was explicitly rejected. â†’ `ADR-0001` D2 + open items, `CC-081`
  Defect 2
- **Silence favoured the agent, and v2 inverts it.** v1 had one clock, so an agent that did nothing
  after delivery got refunded at expiry. v2 has two: the delivery deadline and an agent-set review
  window (12hâ€“14d, bounded by the contract). Once `Delivered`, `expireTask` is unreachable and the
  worker claims via `releaseAfterReview`. â†’ `ADR-0001` D1, `CC-082`
  Â· `npm run test:contracts`
- **The HSM key owns the contracts** â€” `0xa8931097540e69B474013D294d0bA6A2cC853e4b`. This entry has
  been wrong in **both** directions; never re-derive it by reading. â†’ `CC-059`
  Â· `node --env-file=.env.local scripts/audit/verify-contract-owner.mjs`
  Â· **A redeploy resets ownership to the deployer â€” re-transfer it (`CC-082`).**
- **The DB is not the authority on money.** Payout destinations come from the contract, never
  Supabase. Load-bearing for fund safety *and* the regulatory position. â†’ `CC-037`, `CC-051`

**Data and RLS**

- **`tasks_public` bypasses RLS on purpose â€” do not "fix" it.** The view has no `security_invoker`, so
  it runs as its owner; that is the mechanism. Setting `security_invoker = true` silently breaks the
  public task feed. Its safety rests entirely on its explicit column list â€” **never `SELECT *`**, and
  re-check the list whenever a column is added to `tasks`. â†’ migration 011, `CC-030`
- **Anything on `humans` is world-readable.** `humans_read_all` grants anon `SELECT` with
  `qual: true`, deliberately â€” it is the whitepages. Never put anything there that should not be
  public. â†’ `CC-030`
- **"Anon denied" and "anon reads zero rows" are different, and it differs per table.** After
  migration `015`, `waitlist`/`tasks`/`notification_channels`/`used_nonces`/`mcp_challenges` hard-deny
  with `401` + `42501`; `humans` and `tasks_public` keep anon `SELECT` by design. Anything written
  before 2026-08-11 describes the pre-revoke posture. **A newly added table inherits Supabase's
  default `GRANT ALL` â€” revoke it in the same migration.** â†’ `CC-062`
  Â· `scripts/audit/inspect-live-schema.sql` block 4
- **`/api/*` bypasses the coming-soon gate.** Every API route is publicly reachable now. Treat them
  as live.
- **Never log PII.** `maskMeta` masks wallet addresses, not emails, and task payload must never reach
  a log line at all. â†’ `CC-009`, `ADR-0002` D9

**Environment and config**

- **`ESCROW_DEPLOY_BLOCK` must be set** or event queries scan from genesis â€” ~36Ã— the requests.
  Sepolia: **`45494043`**, and it moves with every redeploy â€” it was `39032720` until 2026-08-15,
  which is a valid block and therefore fails slowly rather than loudly. Not a `NEXT_PUBLIC_` var,
  so it takes effect at runtime.
  `RPC_MAX_BLOCK_RANGE` (default `10000`) is a *provider* property and has already moved once.
  â†’ `CC-070` Â· `node --env-file=.env.local scripts/audit/find-deploy-block.mjs`
- **`NEXT_PUBLIC_*` is inlined at build time.** Changing a Vercel env var does nothing without a
  fresh deploy. `NEXT_PUBLIC_COMING_SOON` fails closed â€” the value must be exactly `false`. â†’ `CC-014`
- **Local Supabase credentials are asymmetric.** The anon key is valid; `SUPABASE_SERVICE_ROLE_KEY`
  is the literal placeholder. Anything needing the service role fails `401` locally â€” read the status
  codes, not a script's summary line.
- **KMS locally needs an *impersonated* ADC session, and it expires.** Plain
  `gcloud auth application-default login` cannot sign â€” the signing role sits on
  `kms-signer-svc`, and Aaron holds only `serviceAccountTokenCreator` scoped to it. A lapsed
  session fails as a 400 reading `unable to impersonate â€¦ "error_subtype":"invalid_rapt"`, which
  looks like broken config and is not. â†’ `CC-059`
  Â· `gcloud auth application-default login --impersonate-service-account=kms-signer-svc@carbon-contractors.iam.gserviceaccount.com`

**Wallet and frontend**

- **The tested wallet path is not the shipped one.** With the Coinbase extension installed the
  `injected` connector can win, so the passkey Smart Wallet path â€” the one every mobile user takes â€”
  needs testing in a profile with **no extension**, picking `baseAccount` explicitly. â†’ `CC-055`,
  `Lessons-Learned.md` Â§19
- **CSP failures are invisible when testing with an extension**, because it never touches the page's
  CSP. Test wallet flows on a deployed URL with the console open. â†’ `CC-003`
- **Wallet addresses are lowercase in the DB and enforced.** Migration `014` backfilled and added a
  `CHECK (wallet = lower(wallet))`, so a mixed-case write now **errors** rather than silently
  mismatching. Normalise on both sides of any new query. â†’ `CC-002`

**Git and tooling**

- **You cannot push to `master`.** Branch â†’ PR â†’ merge on GitHub. Two rulesets require verified
  signatures and code scanning; a direct push is rejected. "Push the commits" means this.
- **Commit with the noreply email** `244833942+ajclifft@users.noreply.github.com` or the push fails
  `GH007`. Check `git config user.email` first. â†’ `CC-047`
- **Signing needs a physical YubiKey touch.** `commit.gpgsign=true`, `gpg.format=ssh`, FIDO2 key. A
  commit that appears to hang is waiting for the touch, then fails `invalid format?`. Not a config
  error; retrying does not help. `ssh-add -L` reporting no agent is a red herring. Local commits
  verify `G`; merge commits show `E` because GitHub's key is not in the local keyring â€” that is
  correct, not unsigned.
- **Line endings are pinned** (`* text=auto eol=lf`). If `git status` shows every file modified, that
  is the cause. **Python's `write_text` silently writes CRLF on Windows â€” use `write_bytes`.**
- **A fresh worktree has neither `node_modules` nor `.env.local`, and only `npm run build` says so.**
  Both are gitignored, so neither crosses into `.claude/worktrees/*`. Missing deps surface as
  `Cannot find module .../next/dist/bin/next` â€” run `npm ci` first. Missing env is the trap: because
  `src/lib/config.ts` validation is **lazy**, it does not fail at boot but at page-data collection,
  as `Invalid environment configuration: SUPABASE_URL â€¦` against `/api/fund-task`. `dev`, `lint`,
  `typecheck` and `test` all pass without it, so build is the only step that trips and it reads as a
  code fault. Do not copy `.env.local` into the worktree; supply it for the one command. Node's
  `--env-file` does **not** work â€” Next propagates it into `NODE_OPTIONS` for its workers, which
  reject it `ERR_WORKER_INVALID_EXEC_ARGV`. â†’ `CC-096`
  Â· `set -a; . ../../../.env.local; set +a; npm run build`
- **The test suite is hermetic by enforcement, not convention.** `vitest.setup.ts` strips every
  signing key, RPC URL and live contract address from the environment and blocks global `fetch`. A
  test that reaches the network fails loudly and logs `[CC-060 BLOCKED]`. If you need a real call, it
  belongs in `scripts/audit/`, not a unit test. `ALLOW_TEST_NETWORK=1` bypasses the guard locally â€”
  never in CI. â†’ `CC-060`
- **There are two test suites and two typechecks; `npm test` is only half of each.** `npm test`
  (vitest) covers `src/`; `npm run test:contracts` (hardhat/mocha) covers `contracts/`. Likewise
  `npm run typecheck` covers the Next side and `npm run typecheck:contracts` covers
  `hardhat.config.ts`, `test/` and `scripts/deploy/`. CI runs all four. â†’ `CC-082`
- **The ABIs in `src/lib/contracts/` are generated â€” do not hand-edit them.**
  `npm run compile && npm run gen:abi`. CI fails on drift via `npm run gen:abi -- --check`. A stale
  ABI is indistinguishable at runtime from a contract that lacks the function. â†’ `CC-082`
- **`evmVersion` is pinned to `cancun`** in `hardhat.config.ts`. Solidity 0.8.24 defaults to
  `shanghai`, under which OpenZeppelin 5.6's `Bytes.sol` fails to compile (`mcopy`, EIP-5656). Base
  has had the Cancun opcodes since Ecotone, March 2024. â†’ `CC-082`

## Where truth lives

| Question | Answer |
| :-- | :-- |
| Design decisions and rejected alternatives | `docs/adr/` â€” **read `README.md` first** |
| What needs doing | `docs/backlog/` |
| Product narrative, MCP tool list, stack | `README.md` |
| Security findings AUD-001..010 | `AUDIT-2026-03-25.md` |
| Signer / HSM architecture | `docs/HSM-Deployer-Checklist.md`, `docs/Security-Trust-Disclosure.md` |
| Key-compromise recovery | `docs/Key-Compromise-Recovery.md` |
| Architecture overview, MVP definition of done | `docs/Linear-Document-Archive.md` |
| Pre-July-2026 issue history | `docs/carbon_contractors_full_export.md` |
| What went wrong and what fixed it | `docs/Lessons-Learned.md` |
| Live health | `/api/health` â€” database, escrow contract, session status |

**This file goes stale faster than anything else in the repo.** An audit on 2026-08-13 found five
wrong claims in it â€” a migration range, a test count, a fixed-issue warning, an obsolete branch note,
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
src/lib/config.ts      Zod env schema. Validation is LAZY â€” missing vars surface as 500s at
                       request time, not as a boot failure.
src/lib/categories.ts  The 10 service categories, max 2 per worker
contracts/             CarbonEscrow.sol (v2, CC-082), ReputationStake.sol
                       mocks/ is test-only â€” never deployed to a live network
test/                  Hardhat/mocha contract tests. `npm run test:contracts`
supabase/migrations/   001-015, applied by hand in order. Add new ones, never edit an applied one.
                       No migration runner â€” check the directory for the next number (CC-057).
scripts/audit/         Read-only verification scripts. Run these instead of trusting this file.
```

## Commands

```bash
npm run dev              # Next dev server
npm test                 # Vitest, src/ only. Hermetic â€” vitest.setup.ts blocks the network (CC-060)
npm run test:contracts   # Hardhat/mocha, contracts/ only (CC-082)
npm run typecheck        # tsc --noEmit, Next side
npm run typecheck:contracts   # tsc -p tsconfig.hardhat.json â€” hardhat.config, test/, scripts/deploy/
npm run lint
npm run build
npm run compile          # Hardhat compile
npm run gen:abi          # Regenerate src/lib/contracts/*-abi.ts from artifacts (CC-082)
npm run monitors         # Run every invariant monitor against the LIVE chain (CC-085)
npm run monitors:list    # Offline â€” validates the monitor registry. Runs in CI
npm run seed             # BROKEN â€” still writes the pre-migration-008 `skills` column (CC-017)
```

CI runs `npm ci`, `npm audit --audit-level=high`, lint, typecheck, compile, `typecheck:contracts`,
the ABI drift check, `test:contracts`, `monitors:list`, test, build. The audit step fails the build
on high-severity findings, so a stale dependency tree breaks CI rather than merging quietly.

**The invariant monitors run on a schedule, not in CI** â€” `.github/workflows/monitors.yml`, hourly.
They read the live chain, so no `pull_request` trigger may ever run them. Alerting has two paths and
**path 2 is not live until `MONITOR_WEBHOOK_URL` and `MONITOR_HEARTBEAT_URL` are set as repository
secrets**; without the heartbeat, the schedule silently stopping is indistinguishable from
everything passing. â†’ `CC-085`, `ADR-0003` D3/D5

## Conventions

- **Commits:** conventional, with the issue id â€” `fix(connect): show wallet button on mobile (CC-001)`, so `git log --grep=CC-001` reconstructs the story.
- **Zod everywhere** on external input: API route bodies, MCP tool arguments, env vars.
- **Migrations are append-only.** New file, next number, never edit an applied one. **Check the directory for the next number** â€” there is no runner, and a duplicate `014` was created in August 2026 by trusting this file's stale range instead.
- **Australian English** in user-facing copy. The codebase mixes `-ise`/`-ize`; match the file you are in.

## Do not

- **Do not commit secrets.** `.env.local` is gitignored and has never been in history. **This repo is public** â€” assume anything committed is world-readable, including backlog files and docs. Intentional for defects and reasoning; never acceptable for keys, tokens, Supabase project refs, or anything from `.env.local`.
- Do not sanitise `docs/Lessons-Learned.md` into a highlight reel.
- Do not edit `docs/backlog/INDEX.md` by hand; it is generated.
- Do not assume a fix works because it works locally â€” the CSP, the coming-soon gate and the wallet connector all behave differently in production.
- Do not trust inherited checkboxes in the archived MVP definition of done or the old go-live gate; several were stale when Linear was retired. Re-derive from the code.
