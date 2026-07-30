# Current State — handover to Claude Code

**As at 2026-07-30.** Written to hand this project to a Claude Code session that has live
credentials, after an audit session that could only inspect code and had to ask a human to run
every database query by hand.

> ## §3 has been worked. Read this box before the rest of the file.
>
> A session with live credentials ran §3 on 2026-07-30. Results, and the corrections they force on
> the text below:
>
> - **§3(a) `exec_sql` — resolved, safe.** `anon` cannot execute it (404 `PGRST202`, all six
>   signatures, plus ten sibling names). **The push is no longer gated.** But `SUPABASE_SERVICE_ROLE_KEY`
>   in `.env.local` is the placeholder string `placeholder…`, so whether the function still *exists*
>   and what its grants are remain unmeasured. `scripts/audit/inspect-live-schema.sql` is the
>   one-paste catalog query that closes it. `CC-054` stays open for that.
> - **§3(b) migration 013 — applied.** `keepalive` is absent from a demonstrably current schema
>   cache. `CC-006` closed. Separately, the *reason* the keepalive failed was wrong in this file too:
>   all 22 workflow failures were curl exit 6 (DNS), i.e. the project was already paused. The missing
>   table never caused a single failure. See `CC-006`.
> - **§3(c) toolchain — mostly healthy.** `npm ci`, `lint`, `typecheck`, `build` all exit 0. Tests:
>   74, not 52 — and **flaky, because the suite broadcasts real Base Sepolia transactions** (`CC-060`).
>   `npm audit`: 2 critical, 17 high; `--audit-level=high` exits 1, so **CI will go red on push**
>   (`CC-061`). CI was never red — it has not run on `master` since 2026-05-09.
> - **§3(d) signer — the premise was backwards.** The local raw key **is** the owner of both
>   contracts; the HSM key never received ownership. The published trust disclosure claimed otherwise.
>   `CC-052` closed, `CC-059` opened, `CLAUDE.md`'s landmine corrected.
> - **§2's table is wrong in one respect.** `waitlist`, `tasks`, `notification_channels`,
>   `used_nonces`, `mcp_challenges` are not anon-*denied* — they return `200` with zero rows. The
>   `SELECT` grant is present and RLS alone filters. `CC-062`.
>
> **§4's "first push" was not possible as written.** `master` carries two active rulesets requiring
> verified signatures, code scanning and Copilot review, and commit signing is not configured — so a
> direct push is rejected (`GH013`). The 19 commits went out as
> `claude/verify-live-state-2026-07-30` and PR #43 instead, which is the flow every existing commit in
> `master` used. Author emails also had to be rewritten to the `users.noreply.github.com` address, as
> GitHub refused (`GH007`, correctly) to publish a work email and a personal Gmail into a public repo.
> Both constraints are now landmines in `CLAUDE.md`.
>
> Still open from this file: §3(a)'s catalog query, merging PR #43, and the `SUPABASE_URL` /
> `SUPABASE_ANON_KEY` repo secrets. Once those are done, **delete this file** rather than editing it
> again — that is what §1 of it asks for.

Read `CLAUDE.md` first for conventions and landmines. This file is the *point-in-time* picture:
what is known, what is not, and what to do next. It goes stale — update or delete it once the
immediate queue below is cleared.

---

## 1. What you can do that the previous session could not

The audit session had no database access (Supabase host not resolvable from its sandbox) and no
browser. So a lot below is *prepared but unverified*. With credentials you can close it directly.

You can and should, without asking:

- Query the database read-only (`scripts/audit/inspect-exec-sql.sql`, `scripts/audit/probe-exec-sql.mjs`)
- Run `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
- Read anything, propose plans, write code and migrations

**Ask before doing any of these:**

- Applying a migration to production (Aaron runs these in the SQL editor; confirm before assuming
  one has landed)
- Rotating any key
- `git push` — there are 12 unpushed commits and the visibility question in §4 gates the first one
- Anything that writes to the `humans`, `tasks` or `waitlist` tables in production
- Changing Vercel environment variables

---

## 2. Verified facts — established, do not re-derive

**Repo and branch**
- Local `master` is synced to `origin/master` (was 73 commits behind; fast-forwarded 2026-07-25).
- **12 commits are unpushed.** Working tree clean.
- `.gitattributes` now pins `* text=auto eol=lf`. The phantom whole-tree CRLF diff is gone.
- `origin/claude/nor-195-recovery-runbook` (commit `8df1c7f`) holds a completed key-compromise
  recovery runbook that was never merged. **Cherry-pick the file, do not merge the branch** — it
  predates the current tree and a merge looks like it deletes the backlog. See `CC-049`.
- Repo is **public**: `github.com/carbon-contractors/carbon-contractors.com`. Two PRs open since May.

**Deployment — live and healthy**
- `carbon-contractors.com` serves the coming-soon page. `/api/health` returns
  `database: ok` (~820ms), `escrow_contract: ok`, `sessions: ok`.
- The full site exists behind the gate: `/connect`, `/dashboard`, `/services`, `/learn` (6 modules),
  `/mcp-info`. Not stubs.
- `/api/*` bypasses the coming-soon gate, so **every API route is publicly reachable right now**.

**Database — RLS verified against production 2026-07-30**

| Object | RLS | Policies | Anon reach | Verdict |
| :-- | :-- | :-- | :-- | :-- |
| `humans` | on | 2 | SELECT all | Intentional — public whitepages (`CC-030`, closed) |
| `waitlist` | on | 0 | denied | AUD-001 held |
| `notification_channels` | on | 3 | denied | AUD-001 held |
| `tasks` | on | 0 | denied | AUD-009 held |
| `tasks_public` (view) | n/a | n/a | SELECT | Intended RLS bypass — see landmine in `CLAUDE.md` |
| `used_nonces`, `mcp_challenges` | on | 0 | denied | Locked |
| `keepalive` | on | 1 | SELECT | Being dropped — migration 013 |

So the March audit fixes held. This was their first independent verification.

**Migration 005's `authenticated` policies are inert.** They key off a JWT `wallet_address` claim
that nothing in the codebase mints — the app authenticates by wallet signature, not Supabase Auth.
The migration says so itself. Real posture: anon cannot write, all server writes use `service_role`
and bypass RLS. Consequence for `CC-021`.

**Schema drift is confirmed, not suspected.** Two objects existed in production that appear in no
migration: `exec_sql` and `keepalive`. Both were found by accident. There is no Supabase CLI on this
project (`supabase/config.toml` absent), so migrations 001–013 have been applied by hand. See
`CC-057` — this is the root cause behind `CC-054`.

---

## 3. Open unknowns — resolve these first

### (a) Can `anon` execute `exec_sql`? — blocks the first push

The single unanswered question from the audit. It decides whether `CC-054` is a live critical
exposure or merely untidy.

```bash
node --env-file=.env.local scripts/audit/probe-exec-sql.mjs
```

Or blocks 1–3 of `scripts/audit/inspect-exec-sql.sql` in the SQL editor. Block 2 is the answer.

Decision rule:

- **anon CAN execute** → live critical. Apply `012_restrict_exec_sql.sql`, then **rotate the anon
  and service role keys** on the assumption both are compromised, then check `waitlist` row count
  and `created_at` distribution for exfiltration or tampering.
- **anon CANNOT execute** → not a live exposure. Apply `012` anyway so the access level is recorded
  in version control, and close `CC-054` as found-not-exploitable.
- **absent** → confirm in the SQL editor; absence via PostgREST is not proof. Apply `012` as a
  standing guard.

Either way, add the `docs/Lessons-Learned.md` entry.

### (b) Has migration 013 been applied?

Aaron said he was running `013_drop_keepalive.sql` (drops the `keepalive` table and policy) at
handover. **Verify rather than assume** — it returns a verification `SELECT` expecting zero rows.
The workflow file `.github/workflows/keep_alive.yml` is already deleted in the working tree.
The `SUPABASE_URL` / `SUPABASE_ANON_KEY` repo secrets can go if nothing else uses them.

### (c) Does the test suite still pass?

`npm ci` never completed in the audit sandbox, so **nothing was run**. README claims 52 tests.
`npm audit` also unrun — 19 Dependabot alerts were cleared on 2026-05-09 and the tree has been
untouched since, so expect new findings. CI runs `npm audit --audit-level=high` and fails the build
on it, so check whether CI has been red on `master` for months.

### (d) Is the local signer still the contract owner?

Almost certainly not. `.env.local` has no `GCP_*` vars, so `getSigner()`
(`src/lib/contracts/signer.ts:49-59`) falls back to `DEPLOYER_PRIVATE_KEY`, but `NOR-196` moved
contract authority to the KMS-derived address. Local escrow writes will revert and it will look
like a code bug.

Derive the address from `docs/carbon-contractors-escrow-signer-1.pub` and compare against `owner()`
on the Sepolia escrow contract. `scripts/verify-kms-signer.ts` exists for this. See `CC-052`.

---

## 4. The visibility question gates the first push

The repo is public **by deliberate choice** — see `CC-056` and `Lessons-Learned.md` §8. Building in
public, defects included, is the trust strategy for an unknown solo developer running an escrow
service. Do not suggest making it private; that was proposed, argued, and settled.

One carve-out, and it is why `CC-054` is P0: defects are published as found **except** where they
expose third-party data or are trivially exploitable against real funds. Those are fixed first and
published as found-and-fixed. The `waitlist` table holds real email addresses from real people, and
`exec_sql` is the one open item a reader of the backlog could use to reach them.

**So: resolve §3(a) and apply `012` before the first `git push`.**

---

## 5. Immediate queue, in order

Full detail in each issue file. `docs/backlog/INDEX.md` is the board.

1. **`CC-054`** — resolve §3(a), apply `012`, add lessons entry. *Gates the push.*
2. **`CC-006`** — verify `013` applied, remove repo secrets. Nearly done.
3. **Push the 12 commits.** Do not leave this work on one machine.
4. **`CC-004`** — `/api/dispute` takes an unauthenticated POST and freezes payment on any task.
   Live right now. Mirror the challenge-response pattern in `src/lib/mcp/server.ts:311`. Publish
   the lessons entry after.
5. **The launch bundle — one coherent change, in this order:**
   - **`CC-043`** migrate off OnchainKit to explicit wagmi + viem. Do this *first*: it rewrites the
     two files the next two issues touch, and it changes which CSP hosts are needed. **Trap:** the
     passkey connector currently arrives via OnchainKit's default. Writing an explicit config drops
     it unless you add `baseAccount` deliberately — that would silently remove every mobile user.
   - **`CC-001`** wallet button is `display: none` on mobile, and it is the app's only connect entry
     point. No phone signup is possible.
   - **`CC-002`** wallet casing — registration stores checksummed, lookups query lowercased. Needs a
     backfill migration plus a `CHECK (wallet = lower(wallet))` constraint.
   - **`CC-003`** CSP: no `frame-src` at all, and `connect-src` missing
     `api.developer.coinbase.com`. Also check `Permissions-Policy` for
     `publickey-credentials-get` delegation if the passkey dialog opens then dies.
   - **`CC-055`** then actually complete a passkey signup, on a phone, in a profile with **no
     Coinbase extension installed**. This has never once been done.
6. **`CC-058`** (P0, Aaron's call) — Supabase tier. A paused database during a promotion push
   returns 500s to first-time visitors. Free tier also has no backups, against hand-applied
   migrations.
7. **`CC-005`, `CC-007`, `CC-008`** — remaining launch P0s: no contact capture at signup, no testnet
   warning while promising USDC earnings, no privacy policy while collecting emails from Australian
   users.

Escalate to a stronger model for `CC-037` (escrow trust boundary — it is also the evidence base for
the regulatory position in `CC-051`), `CC-033`, `CC-045`/`CC-046`, and the mainnet gate `CC-039`.

---

## 6. Working agreement

- **The backlog is the source of truth.** Read the issue file before proposing a plan; they carry
  `file:line` references and acceptance criteria.
- **Close the loop:** set `status`, bump `updated`, append what was actually done and in which
  commit, run `node scripts/backlog.mjs`, reference the id in the commit message.
- **Then ask whether it earned a `docs/Lessons-Learned.md` entry** — transferable lessons only, and
  do not sanitise them. That document is a deliberate trust artefact.
- **Do not trust inherited checkboxes** in the archived MVP definition of done or the old go-live
  gate. Several were stale. Re-derive from code.
- **Verify, do not infer.** The audit session twice asserted database state from the migration files
  and was wrong both times (`Lessons-Learned.md` §9). You have credentials — query it.
- Australian English in user-facing copy.

## 7. Known-wrong things previously asserted

Recorded so they are not repeated as fact:

- "The `keepalive` table does not exist, so the cron is erroring." It existed. Then: "the cron
  works." It ran, and Supabase paused the project anyway. Both were inference.
- An early review of the escrow trust boundary raised serious findings against a tree 73 commits
  stale. Most are probably fixed. `CC-037` exists to re-derive them properly — treat the original
  claims as unproven, in both directions.
- Commit timestamps on the first six commits read 2026-07-25 and the rest 2026-07-30; the session
  genuinely spanned those dates.
