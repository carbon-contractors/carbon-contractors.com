# Lessons Learned

A living record of what went wrong in this project and what fixed it.

This exists because Carbon Contractors is a solo build by someone with no public track record,
asking people to trust it with money. Asserting "it's been hardened" is worthless. Showing the
defects, the reasoning, and the fixes is worth something. Every entry below is a real problem
found in this codebase, not a hypothetical.

**Method.** Each entry: what was wrong, why it survived review, what fixed it, and the
transferable lesson. Entries are added as issues close — see `docs/backlog/` for the live tracker.
Nothing is removed once written, including the embarrassing ones.

**On "vibe coded."** Much of this codebase was written with AI assistance. That is not the
interesting risk. Plenty of it has a hermetic test suite, a CI pipeline that fails on high-severity
audit findings, eleven RLS migrations, and an HSM-backed signer — that is not what unexamined code
looks like. The actual risk, visible repeatedly below, is narrower and more mundane: **code that
was generated, appeared to work, and was then never re-read.** Generation is cheap; verification is
the part that requires deliberate effort. Several entries below are that exact failure.

---

## 1. The path you test is not always the path you ship

**Status:** open — `CC-055`, `CC-003`, `CC-001`

Every wallet test in this project's history used the Coinbase Wallet browser extension: a
seed-phrase EOA that injects `window.ethereum`. But `src/lib/wallet/providers.tsx` configures no
wagmi config and no connectors at all — it inherits OnchainKit's default, which is the
`baseAccount` passkey connector. With the extension installed, the extension wins.

So the passkey Smart Wallet flow — the one the entire product pitch rests on, and the only route
available to a phone user, since browser extensions don't exist on mobile — had never been
executed once. Not known broken. Unknown, which is worse, because it reads as tested.

Three separate defects had accumulated on that single untested route: the connect button was
hidden by a mobile media query, the CSP blocked the passkey iframe, and nobody had ever completed
the flow to notice either.

**Why it survived:** the developer's environment was more capable than the user's, in a way that
silently substituted a working path for a broken one. Nothing errored. Nothing looked wrong.

**Lesson:** if your dev environment has a capability your users don't, you are not testing your
product. For wallets specifically: test in a profile with no extension installed. The convenience
tool that makes your life easier is the thing hiding the defect.

---

## 2. Content-Security-Policy failures can be structurally invisible

**Status:** open — `CC-003`

The deployed CSP had no `frame-src` directive at all, so the `keys.coinbase.com` passkey iframe
fell back to `default-src 'self'` and was blocked outright. `connect-src` omitted
`api.developer.coinbase.com`, where the default transport and the identity components send their
requests.

Both would break wallet connection completely in production. Neither ever appeared in testing,
because the browser extension signs in its own popup and proxies RPC through its background
context — it never touches the page's CSP at all.

**Lesson:** CSP correctness cannot be established locally or through a proxying extension. It has
to be verified on a deployed origin, in a clean profile, with the console open. A CSP that has
never rejected anything has never been tested.

---

## 3. Two spellings of the same address is two different records

**Status:** open — `CC-002`

Registration wrote the EIP-55 checksummed, mixed-case address supplied by wagmi. Every lookup
queried `.eq("wallet", wallet.toLowerCase())`. The column is case-sensitive `TEXT UNIQUE`.

Result: profile lookup returned 404 for every worker who had ever registered, the dashboard
profile card never rendered, the MCP `get_contractor` tool could find nobody, and the same person
could register twice under two casings without tripping the unique constraint.

**Lesson:** an address is a value with multiple valid encodings, so pick a canonical form and
enforce it in the schema, not by convention. `CHECK (wallet = lower(wallet))` makes the bug
impossible; remembering to call `.toLowerCase()` at seven call sites does not. Any identifier with
more than one valid representation deserves the same treatment.

---

## 4. Build-time constants look exactly like runtime configuration

**Status:** open — `CC-014`

`middleware.ts` and `src/app/page.tsx` both read `NEXT_PUBLIC_COMING_SOON` at module scope. Next
inlines `NEXT_PUBLIC_*` at build time, and `/` is statically prerendered. Changing the value in
the hosting dashboard therefore does nothing at all until a fresh deploy.

The flag also fails closed — the string must be exactly `false` — which is correct, and doubles
the confusion when it appears not to work.

**Lesson:** an environment variable that is inlined at build time is not configuration, it is a
compile-time constant wearing configuration's clothing. Either document that loudly at the read
site or move the decision to a runtime source. Failing closed is right; failing closed silently
is a trap.

---

## 5. Off-chain state drifting into a second source of truth

**Status:** under verification — `CC-037`, and the argument it underpins in `CC-051`

The design principle is unambiguous: on-chain escrow state is authoritative for money, the
database is a projection. Holding that line under pressure is harder than stating it, because the
database is always the more convenient thing to read.

This one is listed as under verification rather than resolved, deliberately. An earlier review
raised serious concerns here, but it was run against a tree 73 commits stale, and fixes had
landed since. Re-asserting the finding without re-reading current code would have been the same
class of error as the original bug.

There is a second reason it matters. The strongest argument that this platform is not custodial
is not "the operator cannot extract the signing key" — that is true but beside the point, because
the operator can still direct the key to sign. The argument that holds is **"the contract permits
no destination other than the on-chain worker or a refund to the funding agent."** That is a claim
about reachable code paths, independently checkable on a block explorer. Which means verifying it
is not only a security task; it is what makes the claim honest enough to publish.

**Lesson:** stated invariants decay unless something checks them. And be specific about which
property is doing the work — key custody and disposition control are different things, and
conflating them produces a reassuring argument that does not survive scrutiny.

---

## 6. Four months of dormancy is not a neutral pause

**Status:** resolved 2026-07-30 — `CC-053`, `CC-052`, `CC-049`

The project sat untouched from May to July 2026. Picking it back up surfaced more process debt
than code debt:

- The **local checkout was 73 commits behind** the remote. The first review pass of this session
  audited code four months out of date and produced findings that were already fixed. Wasted
  effort, and nearly published as fact.
- **Completed work was stranded.** A finished key-compromise recovery runbook sat on an unmerged
  branch for three months. The issue tracker said the work was done, because it was — just not
  anywhere it took effect.
- **The tracker had drifted from reality.** The consolidated go-live gate still showed items
  unticked that were marked Done elsewhere. Inherited checkboxes could not be trusted.
- **The signing key changed underneath local dev.** Contract authority moved to the HSM, so the
  raw key still in `.env.local` is no longer the owner. Local escrow writes now revert in a way
  that reads as a code bug.
- **A hardware upgrade** (new CPU and motherboard) invalidated a category of credentials —
  TPM-bound ones. It happened to cost nothing here, because Windows Hello was never used as a
  passkey provider, but the exposure was real and unexamined until asked about.
- **The law changed.** Australia's Corporations Amendment (Digital Assets Framework) Bill 2025
  received Royal Assent on 8 April 2026 while the project was dormant, creating a Digital Asset
  Platform category that an escrow service needs a considered view on. No code changed; the
  environment did.

**Lesson:** the first hour back on a dormant project belongs to `git fetch`, checking for unmerged
branches, reconciling the tracker against the code, and asking what changed in the world — not to
writing code. Every one of the above would have been discovered eventually, at higher cost, by
trusting a stale assumption.

---

## 7. Diffs you cannot read are diffs you do not read

**Status:** resolved 2026-07-30

The repository had no `.gitattributes`. A Windows checkout produced a phantom whole-tree diff:
60 files, 27,649 insertions and 27,649 deletions, entirely CRLF churn. Every real change was
buried in noise, and `git diff` was effectively useless as a review tool.

Fixed by pinning `* text=auto eol=lf` and normalising the working tree.

**Lesson:** line-ending hygiene is not cosmetic. If reviewing your own diff is painful, you stop
reviewing your own diff — and that is the actual cost, not the noise itself.

---

## 8. Publishing your defects is a stronger signal than publishing your polish

**Status:** decided 2026-07-30 — `CC-056`, `CC-028`

An earlier recommendation in this project's review was to make the repository private before
pushing a backlog that documents live, unfixed defects with `file:line` precision. That
recommendation was withdrawn, and the reasoning is worth recording because it is a genuine
trade-off rather than an obvious call.

The case for private: a public issue tracker describing an unauthenticated endpoint on a live
deployment is a working exploit list, indexed and searchable.

The case for public, which won: this is a solo project with no users, no real money, and testnet
funds only, so the exploitable surface is close to nil. Meanwhile the trust deficit is the actual
problem to solve — an unknown developer asking people to trust an escrow service cannot fix that
with assertions. Verifiable self-scrutiny is the only currency available. Hiding the defect list
until everything is clean produces a repository that looks like every other project that has
never been examined.

**One carve-out was retained.** Publishing a pointer to an unfixed defect is acceptable when the
downside falls on the operator. It is not acceptable when it falls on someone else. The `waitlist`
table holds real email addresses from real people who signed up in good faith, so the one item
fixed before publication was the database access path that could expose them (`CC-054`). Risk you
can accept on your own behalf is different from risk you accept on behalf of third parties.

**Disclosure policy, going forward.** Defects are published as they are found, with two
exceptions: anything that exposes third-party data, and anything trivially exploitable against
real funds, is fixed first and published after. Everything else is published immediately, unfixed,
with the reasoning intact.

**Lesson:** "build in public" is only a trust signal if it includes the parts that make you look
bad. A repository containing only successes is indistinguishable from one that was never audited.

---

## 9. "Closed" and "verified" are different words

**Status:** resolved 2026-07-30 — the fixes held

Six security findings in `AUDIT-2026-03-25.md` were fixed in March by writing migrations. The
migrations were committed, the issues were closed, and nobody checked the live database afterwards.
Four months later, the first independent inspection of production returned:

- `waitlist` — RLS enabled, zero policies, so anon is denied. AUD-001 held.
- `notification_channels` — RLS enabled, no anon SELECT policy. AUD-001 held.
- `tasks` — RLS enabled, zero policies; anon reads a view that excludes `task_description`.
  AUD-009 held.
- `humans` — anon-readable by deliberate design, as intended.

So the work was correct. That is a good result and not the point. The point is that it was
*unverified for four months*, and the same inspection turned up two objects in production —
`exec_sql` and a `keepalive` table — that exist in no migration at all. The schema in version
control was known-incomplete and nobody knew.

Two errors were made *during* that inspection and are worth recording, because they are the same
error twice:

1. A `keepalive` table was declared missing because it was absent from the migrations. It existed.
   Absence from your records is not absence from reality.
2. It was then declared working because it existed and the cron was running. It wasn't — Supabase
   paused the project regardless. Existence is not function.

**Lesson:** a closed ticket is a claim about the past. Verify security properties against the live
system, on a schedule, with a script you keep — not against the migration files, which only record
what you *meant* to happen. And when the check is cheap, run it before asserting anything: both
errors above came from inferring state instead of querying it.

The queries are now kept in `scripts/audit/inspect-exec-sql.sql` precisely so this is repeatable
rather than a one-off act of archaeology.

---

## 10. The checklist was honest. The prose was not.

**Status:** found 2026-07-30, documentation corrected the same day, underlying fix tracked as
`CC-059`

`docs/Security-Trust-Disclosure.md` is the document that asks a stranger to trust an escrow service
run by one person. Its argument is that trust is unnecessary because a hardware security module, not
a human, controls the contracts. It stated:

> The Ethereum address derived from the KMS public key matches the owner/signer address on the
> deployed escrow contract. You can verify this yourself: check the contract owner address on
> Basescan… confirm they match — proving the on-chain contract is controlled by the HSM key.

It does not match. Measured on Base Sepolia:

- HSM-derived address: `0xa8931097540e69B474013D294d0bA6A2cC853e4b`
- `CarbonEscrow.owner()`: `0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b` — a conventional private key
  sitting in a local `.env.local` file

The HSM key was created, its attestation obtained, its address funded with 0.101 test ETH. The step
that would have mattered — `transferOwnership()` — was never performed. Everything *around* the
security property was built. The property itself was not.

### Why it survived

Because the same repository recorded it correctly, and nobody reconciled the two documents.
`docs/HSM-Deployer-Checklist.md` lists the step at line 47, and its verification section carries
these as **unticked boxes**:

```
- [ ] Ethereum address derived: KMS public key → Ethereum address matches contract owner
- [ ] DEPLOYER_PRIVATE_KEY removed: Not present in any deployed environment variables
```

So the checklist was accurate and the marketing prose was not, and the prose is the document a
reader sees. An unticked box is a quiet, easily-ignored artefact; a confident paragraph is not. The
gap survived four months of dormancy and two reviews.

There is an irony worth naming. `CLAUDE.md` already warned "do not trust the inherited checkboxes…
several were stale." Here the checkboxes were the only thing telling the truth. The instruction was
right in spirit — verify against the system — and would have been actively misleading if followed as
a heuristic about which document to distrust.

### Why this one is worse than an ordinary bug

The claim was **falsifiable by any reader in thirty seconds**, and the document invited them to try.
A wrong security claim that a stranger can disprove does more damage to trust than saying nothing at
all, because it converts "unproven" into "demonstrably careless." For an unknown solo developer
holding other people's money, that is the whole asset.

No user funds were ever at risk — Base Sepolia, test USDC, `totalLocked() = 0`. That is luck of
timing, not a mitigating design decision.

### What fixed it

The document now leads with the measured mismatch, marks each row of its threat table as in force or
not, and keeps the false claim visible as a quotation rather than silently editing it away. The
check is now a script, `scripts/audit/verify-contract-owner.mjs`, which derives the HSM address
offline from the committed public key, reads `owner()` on chain, and **exits non-zero while they
disagree** — so it can be wired into CI and stop being a matter of prose.

**Lesson:** any security claim you publish must be produced by something that can fail. If a
document asserts a property, the property needs an executable check with the document's name on it,
and the check must run. Prose has no exit code. Where a checklist and a narrative disagree about the
same system, believe neither — go and measure — but note which one was written to persuade.

---

## 11. A placeholder credential produced a security finding

**Status:** caught 2026-07-30 before it was written down as fact

The open question blocking the first public push was whether the `anon` role could execute an
out-of-band `exec_sql` RPC. A probe script was written for it. Its first step tries the function with
the **service role** key under six candidate parameter names, since the signature was unknown. Its
output:

```
exec_sql(sql)       -> 401
exec_sql(query)     -> 401
… four more …
No exec_sql reachable via PostgREST under any tried parameter name.
Either it does not exist, it is not in an exposed schema, or the signature differs.
```

That conclusion is worthless. `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` is the literal string
`placeholder…` — 33 characters, not even JWT-shaped. Every one of those 401s is *"you are not
authenticated"*, and the script rendered them as *"the function is not there."*

It was caught because the status codes were printed next to the summary, and 401 is not 404. Had the
script printed only its verdict — which is exactly what a tidier script would do — the finding would
have been "no `exec_sql` exists, CC-054 closed" and it would have been wrong, in the reassuring
direction, on the one issue gating publication of a database holding real email addresses.

### The near-miss inside the near-miss

The decisive test in the same script uses the **anon** key, and that key is valid. It returned
`404 PGRST202` — genuinely "no such function in the schema cache". So the actual answer was correct
and the exposure is not real. But the right answer arrived beside a fabricated one, from the same
script, in the same run, and the two are only distinguishable by reading HTTP status codes.

Note also what could not be established at all: whether `exec_sql` still *exists*. Proving absence
needs `pg_catalog`, and the endpoint that would enumerate it is service-role only. So the placeholder
key did not merely produce a false statement — it removed the ability to check the true one.

### What fixed it

The verdict lines now distinguish the three outcomes explicitly — not found (`PGRST202`/`PGRST205`),
not permitted (`42501`), not authenticated (`401 Invalid API key`) — and `CLAUDE.md` carries the
asymmetric-credentials landmine so the next session does not spend an hour on it. The catalog query
that actually answers the existence question is kept in
`scripts/audit/inspect-live-schema.sql`.

**Lesson:** a probe that cannot tell *"absent"* from *"you are not allowed to look"* from *"your
credentials are broken"* will eventually report the most comforting of the three. Assert your
preconditions before your conclusions: a script that needs a credential should verify the credential
works, loudly, before interpreting anything it returns. And treat every negative security result as
requiring proof that the test could have come back positive.

---

## 12. The test passed because doing nothing succeeded

**Status:** found 2026-07-30, **fixed 2026-08-13** — `CC-060`. See *"Three green runs proved
nothing"* at the end of this entry, which is the part worth reading if you already know the story.

`src/lib/__tests__/signer.test.ts` sets a deliberately fake escrow address
(`0x1234567890123456789012345678901234567890`) and Hardhat account #0's publicly known private key,
then calls `completeTaskOnChain` and expects it to fail. The comment says why:

> Trigger account creation by calling an on-chain function. It will fail at `simulateContract` since
> there's no RPC, but `createKmsAccount` should have been called.

There is an RPC. `BASE_SEPOLIA_RPC_URL` is unset, so `getChainConfig()` falls back to the chain
default — the public `sepolia.base.org` endpoint. And `simulateContract` does not fail, because
**`eth_call` against an address with no code succeeds.** It returns empty data. Nothing reverts.

So execution continued into `writeContract`, and the test suite broadcast a real transaction to Base
Sepolia:

```
tx     0x1cc38f04139e49370470258905788b72827cc3052ebd120be583a53e7255647d
block  44801606
from   0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266   (Hardhat account #0)
to     0x1234567890123456789012345678901234567890   (no code)
status success, 22440 gas
```

### Why it survived

Because it passed. The assertion was `expect(mockCreateKmsAccount).toHaveBeenCalled()`, wrapped in
`try/catch`, and that assertion is true whether the call reverts, succeeds, or broadcasts a
transaction to a live network. The test verified a side effect while silently permitting the main
effect. Every CI run since it was written was green.

It surfaced only as *flakiness*. Five consecutive runs on an unchanged tree gave 3 failures, then 1,
then three clean runs — because the suite was competing for the same public RPC as an unrelated audit
script running alongside it. The bug announced itself as network noise, which is the easiest class of
failure to dismiss as someone else's problem.

### What makes it worse than a wasted transaction

Nothing was harmed: a throwaway key, a codeless target, 22440 gas of testnet ETH. But Vitest loads
`.env.local` into `process.env`, and CI supplies stub values instead — so local and CI have never run
the same test. `DEPLOYER_PRIVATE_KEY` in that file is currently the **owner** of the escrow contract
(§10). The distance between this test and one signing a real state change as the contract owner is a
single stubbed variable.

**Lesson:** assert the thing you actually mean. A test whose pass condition is "something threw", or
"a mock was reached", will keep passing after the behaviour underneath it changes shape entirely —
and a test that reaches the network can do real work while reporting success. If a unit test can
transact, it is not a unit test; make the transport unreachable rather than trusting a fake address
to be rejected. When tests go flaky, suspect the test before the network.

### Fixed 2026-08-13 — and one correction to the above

`vitest.setup.ts` now strips every signing key, real RPC URL and live contract address from
`process.env`, and replaces global `fetch` with a thrower. Every client in this codebase — viem,
supabase-js — goes through `fetch`, so a real request is now impossible rather than merely
discouraged. `signer.test.ts` mocks `createPublicClient`/`createWalletClient` and asserts the
*intent*: that `simulateContract` is called with the right arguments, that the prepared request is
exactly what gets written, and that a simulate rejection means no write happens.

**Correction:** the paragraph above says Vitest loads `.env.local` into `process.env`. Measured on
2026-08-13, it does not — `DEPLOYER_PRIVATE_KEY` was absent, and the escrow address unset. So the
"single stubbed variable" gap was narrower than stated. The environment is stripped anyway, because
the reason it was safe was accidental: nobody had added dotenv loading, changed the runner, or
exported the variable in their shell.

### Three green runs proved nothing

This is the part that generalises, and it caught us *after* the defect was already understood.

With the fetch guard installed, the suite went 128/128 three times in a row. That looked like proof
of hermeticity. It was not. Adding a `console.error` to the guard — so a blocked attempt is *logged*
as well as thrown — showed **4 blocked network requests on every single run, with the suite still
reporting 128/128 passed.**

Four, because that is viem's default retry count: one attempt and three retries. All from the same
test, every run, for weeks. The suite was green *and* reaching for the network, simultaneously, and
the only reason it stayed green is that the failure was swallowed downstream of the assertion.

So a passing suite is not evidence that a suite is hermetic. Green tells you the assertions held; it
tells you nothing about what the code attempted on the way. If you care whether tests touch the
network, **count the attempts** — do not infer it from the result.

The final verification was therefore built around measurement rather than absence of failure: 20
consecutive runs, 131/131 each, **zero** blocked attempts, and Hardhat account #0's on-chain
transaction count read before and after — unchanged at 23842. Since that key is publicly known and
shared, "unchanged" means nobody broadcast anything, which is a stronger statement than "we did not".

**Lesson:** when you fix a test-isolation problem, instrument the boundary you just closed and check
it reports zero. A guard that throws proves the path is blocked; a guard that *counts* proves the path
is no longer being taken. Those are different claims, and only the second one tells you the code was
actually fixed rather than merely contained.

---

## 13. Two front doors to the same mutation, and only one got a lock

**Status:** found 2026-07-25, fixed 2026-08-01, tracked as `CC-004`

A task can be flipped to `disputed` through two separate entry points that both end at the same
`updateTaskStatus(id, "disputed")` call: the `dispute_task` MCP tool, and `POST /api/dispute`, a
REST endpoint the dashboard calls after submitting the on-chain `disputeTask` transaction. The MCP
tool has required a verified wallet signature since it was written — `context.callerWallet` must
match the task's assigned wallet, checked against a nonce minted by
`/api/basedhuman.mcp/challenge` and consumed via `viem.recoverAddress`. `/api/dispute` had none of
that. It read a `payment_request_id` straight from an unauthenticated POST body and froze the task.
And because `middleware.ts` only gates page routes, not `/api/*`, it was reachable on the live site
the whole time — anyone who could see or guess a `payment_request_id` could freeze payment on any
task.

### Why it survived

The two call sites were built at different times for different callers (an MCP agent vs. a
browser dashboard), so they read as unrelated code, not as one security boundary implemented twice.
The REST endpoint's own docstring undersold what it does — "Updates database status only... the
worker must also call `escrow.disputeTask()` on-chain" reads like an internal bookkeeping detail,
not a mutation with no caller identity check in front of it. Nothing forced the two paths to stay
in parity, so the security work landed on one and was simply never carried over to the other.

### What fixed it

`verifyChallengeSignature` was pulled out of the MCP route handler into
`src/lib/auth/wallet-challenge.ts` so there is exactly one implementation of the check, not two to
keep in sync. `/api/dispute` now requires the same `x-caller-wallet` / `x-caller-signature` /
`x-caller-nonce` headers as the MCP transport, verified against the same nonce table, and rejects
unless the recovered wallet matches the task's `to_human_wallet` — the assigned worker, since this
endpoint is worker-initiated (the MCP tool instead checks `from_agent_wallet`, the requesting
agent; same lock, different key, because the two callers are different parties to the same task).

**Lesson:** when one state mutation is reachable through more than one transport, put the
authorization check in one shared function that every caller goes through, not in each handler
separately. "Mirror the pattern" is an instruction to extract and reuse, not to retype — retyping
is exactly how the second copy quietly stays unauthenticated while the first one gets reviewed.

---

## 14. Three green gates and a broken homepage

**Status:** found and fixed 2026-08-01, during `CC-043`

Migrating off OnchainKit to a standalone wagmi config (`src/lib/wallet/providers.tsx`) meant
wiring `baseAccount` as an explicit connector for the first time, instead of getting it for free
from OnchainKit's default. `npm run typecheck` passed. `npm run lint` passed. The full `vitest`
suite passed, 80 tests, same as before the change. By every check this repo runs in CI, the change
was done.

The homepage didn't load. `next dev` threw `Module not found: Can't resolve 'bs58'` on every
request, 500ing `/`. The cause was three layers down: `wagmi/connectors`'s `baseAccount()` pulls in
`@base-org/account`, whose Node SSR entry (`dist/index.node.js`, via
`getOrCreateSubscriptionOwnerWallet.js`) bundles a copy of `@coinbase/cdp-sdk` that imports `bs58`
in three files — and that package's own `package.json` doesn't list `bs58` as a dependency at all.
Nothing in this repo was wrong. An upstream package was shipping code that only works if some
*other* dependency in the tree happens to hoist `bs58` to a resolvable location, which it did not.

### Why the gates missed it

None of them render the page. `tsc --noEmit` type-checks; it doesn't bundle. `eslint` reads syntax
trees; it doesn't resolve a module graph. `vitest` imports individual modules under mocks it
controls — nothing in the 80-test suite imports `src/lib/wallet/providers.tsx`, because nothing
needs to unit-test a provider wrapper. The one thing that actually resolves the real import graph
Next.js will ship — the bundler, walking every `import` starting from `layout.tsx` — is the one
step that isn't part of any of the three checks. It only ran when a dev server actually started and
a page actually loaded in a browser.

### What fixed it

Adding `bs58` directly as a top-level dependency. Node's module resolution walks up from the
nested import site toward the project root looking for `node_modules/bs58` at each level; a
top-level install satisfies that walk without touching the vendored package. This is a workaround
for someone else's missing dependency declaration, not a real fix — it will need re-checking if
`@base-org/account` or `@coinbase/cdp-sdk` bump versions.

**Lesson:** typecheck, lint, and unit tests verify three different, narrower things than "the app
runs." None of them execute a bundler's module resolution against the actual dependency tree that
ships. CLAUDE.md already says frontend changes must be checked in a running browser before being
called done — this is the concrete failure mode that rule exists to catch: a change that is
correct in every static sense and still 500s on load, because the only thing that would have caught
it is the thing that was skipped.

---

## 15. A dependency can go quietly unusable while every other check stays green

**Status:** found and fixed 2026-08-04, tracked as `CC-064`

Discovered by accident, trying to dry-run an unrelated script for `CC-059`: every single Hardhat
command in this repo — `npm run compile`, both deploy scripts, a brand-new script that had never
run before — failed identically with `Hardhat only supports ESM projects`. Not a regression from
that session's own work; reproduced with the pre-existing `scripts/deploy/escrow.ts` untouched.
`hardhat` had drifted from `^3.2.0` to `3.12.0`, a major version that dropped CommonJS support
outright, and this repo had never been updated to match.

### Why it survived

Nobody had run a Hardhat script in long enough that nobody noticed. Same shape as entry #12's
flaky test and CC-057's schema drift: `npm ci`, `npm run typecheck`, `npm run lint`, `npx vitest
run`, and `npm run build` all stayed green through this the entire time, because none of them
touch the contracts toolchain at all — it is exercised only by a human (or an agent) actually
running `npx hardhat run` or `npm run compile`, which per `CC-061`'s own investigation hadn't
happened since well before the last CI run on `master`.

It got worse on inspection. The installed `@nomicfoundation/hardhat-toolbox@^7.0.0` — the
"recommended bundle" pinned in `package.json` — turned out to be a deprecated stub: its own
`package.json` `homepage` field pointed at a `github.com/.../tree/deprecated-versions/...` branch,
and simply installing it printed a warning that it "does not work with Hardhat 2 nor 3." `npm
install` had been silently satisfying `^7.0.0` with a package the Hardhat team themselves had
already end-of-lifed, for however long that range had been in `package.json`. A pinned major
version range is not the same claim as "this major version is maintained and correct" — nothing
in `npm install`'s own output flags a resolved package as abandoned.

### What fixed it, and what it took

Not a config flag. The docs site's own migration guide was accurate on the shape of the change
(`"type": "module"`, `defineConfig()`, a real ethers-based replacement package) but thin on
specifics; the reliable source turned out to be the framework's own GitHub repo — its committed
example templates and internal test fixtures showed the actual `network.create()` API, the
`configVariable()` resolution behaviour, and the `ChainType` values in working, current code,
which the rendered docs pages didn't. `gh search code` against the upstream repo did more to
unblock this than three attempts at the hosted docs.

Fixing it surfaced a second, separate finding: the deprecated toolbox's dependency tree carried an
`elliptic` advisory with **no fixed version available at all** — the latest release still has it.
The advisory only reached this repo through `hardhat-verify` and `hardhat-ignition`, two plugins
bundled into the toolbox that nothing here calls (no contract-explorer verification, no
Ignition-based deployments). Swapping the toolbox meta-package for the specific plugins actually
used dropped that entire vulnerable subtree — turning an "accept the risk, no fix exists" situation
into zero unresolved findings, by removing surface area instead of waiting for upstream.

**Lesson:** a dependency range that resolves cleanly and installs without error is not the same
claim as "this is a maintained, working version" — `npm install` has no concept of "this package
is abandoned," only "this range is satisfied." And a toolchain that nothing in CI actually
exercises can go completely unusable while every automated check stays green, because green checks
only prove what they run. If a whole class of tooling (here: anything touching contracts) isn't
exercised by CI, treat "nobody's complained" as "nobody's tried," not as "it works."

---

## 16. The most dangerous kind of failure message is the one that's wrong

**Status:** happened and correctly caught 2026-08-08, closing `CC-059`

`CC-059` had been open since 2026-07-30: the deployed escrow contracts were owned by a raw local
key, not the HSM address Vercel actually signs as, so `resolveDisputeOnChain` reverted in
production. The fix was a one-way, irreversible on-chain `transferOwnership()` call — exactly the
kind of action this project's own rules require explicit go-ahead for, immediately before running
it. That approval was given. The script ran, sent two real transactions, and printed:

```
CarbonEscrow: FAILED
ReputationStake: FAILED
```

Both had actually succeeded. `transferOwnership()` was confirmed on-chain for both contracts —
independently verified against Basescan directly, `OwnershipTransferred` emitted, no reverts. The
script's own `contract.owner()` re-read, executed immediately after `tx.wait()` resolved, against
the same public `sepolia.base.org` RPC endpoint used to send the transaction, returned the *old*
owner — a stale read on a load-balanced public gateway with no read-your-writes guarantee across
its backend nodes. The write landed on one node; the very next read a few milliseconds later hit a
different one that hadn't caught up yet.

### Why this is worse than a script that just crashes

A script that throws an exception announces "something is wrong, go look." A script that prints a
clean, confident `FAILED` in a well-formatted summary table announces "something is wrong, and I
already looked, and here's the answer" — which invites trusting it instead of checking further. On
an irreversible action, believing a false negative can be actively worse than believing a false
positive: the natural next move after "it failed" is often "try again," and this project's own
history (`Lessons-Learned.md` #10, #12) is full of exactly this shape of problem — a check that
looks authoritative but is answering a narrower question than it appears to.

It was caught here specifically because the result was checked against a *second, independent*
source — the transaction hash on a block explorer — rather than trusted or re-run. Re-running would
likely have been harmless in this specific case: the script's own safety check
(`currentOwner !== deployerAddress → ABORT`) would have refused to proceed on a second attempt,
since by then the real owner was already the HSM address, not the deployer key signing the retry.
But that safety margin was a property of this particular script, not something to rely on in
general — the instinct to independently verify before reacting is the actual lesson, not "it would
have been fine anyway."

**Lesson:** for any check that reads state immediately after writing it, on infrastructure you
don't control the consistency model of (a public RPC gateway, a load-balanced API, anything without
an explicit read-your-writes guarantee), do not trust that immediate read as the verdict — verify
independently, or wait and re-read, before concluding failure. This applies with the most force
exactly when the stakes are highest and the temptation to act immediately on the reported result is
strongest.

### A smaller version of the same mistake, earlier in the same evening

Getting to the point of running that script required granting a Google Cloud IAM permission
(`Service Account Token Creator`) so a personal account could impersonate the signing service
account for local testing. The first attempt granted it on the **project-level** IAM page — which,
read at a glance, looked like the right principal had gained the right role. It hadn't: that page
put the role on the *service account itself* rather than on the human account, backwards from what
was needed, and the actual permission error on the next attempt (`iam.serviceAccounts.getAccessToken
denied`) was the thing that surfaced it. Same shape as the stale RPC read: a console screenshot that
looks authoritative is still worth checking by principal, not just by "does a row exist," before
trusting it as proof the grant is right.

---

## 17. A function can be correct and still never run

**Status:** found 2026-08-08 while closing `CC-059`; filed and fixed same day as `CC-065`

Once `CC-059`'s fix (escrow ownership transferred to the KMS key) needed proving, the obvious test
was: does `resolveDisputeOnChain` actually work now? Writing that test meant first checking how the
product itself calls it, so the test would exercise the same path a real dispute takes. It doesn't
call it at all. `resolveDisputeOnChain` (`src/lib/contracts/signer.ts`) is exported, has a
docstring, has type signatures that all line up, and is never imported into `src/lib/mcp/server.ts`.
The `resolve_dispute` MCP tool updates the database row and returns a text note asking the *caller*
to go call the contract themselves. It reads like a TODO that got left as shipped behaviour.

This is a different shape of bug from `CC-037` in the same file, `completeTaskOnChain`, which *is*
called but fails on-chain every time because of an access-control mismatch. That one fails loudly —
a revert, a thrown error, something to notice. This one fails silently: the database says
`completed`, the caller gets a success response, and nothing on-chain ever moves. Nothing crashes.
Nothing logs a warning. The only way to notice is to go looking for the call site and find that it
isn't there.

Both bugs survived in the same file, in adjacent functions, for the same underlying reason: the
on-chain write half of a two-system operation (database + contract) was designed and documented but
the wiring was never finished, and nothing forced a check that the two systems actually agree after
the "success" response. Tests exist for `completeTaskOnChain` (`signer.test.ts`) — not because
`resolveDisputeOnChain` was judged safe, but because nobody wrote a test that would have needed to
call it, which is exactly the gap that let it go unnoticed.

**Lesson:** verifying a fix to a function is not the same as verifying the *product* uses that
function. Before treating "the code now does X correctly" as done, check that something in the
actual call graph reaches that code — `grep` for real call sites, not just the definition and its
own tests. A correct function with no caller is not a smaller bug than an incorrect function with a
caller; for a two-system operation like escrow state, it's the same bug — the two systems can
diverge — with a quieter failure mode.

---

## 18. The error handler swallowed the error, in exactly the case that mattered most

**Status:** found and fixed 2026-08-08 while shipping `CC-067`

Adding a self-serve waitlist unsubscribe (`CC-067`) meant testing it against the real Supabase
project, not just a mock — and the local environment's `SUPABASE_SERVICE_ROLE_KEY` is a documented
placeholder (see `CLAUDE.md`'s own landmine list), so the test correctly failed with an auth
rejection. The UI showed the failure as the literal string **`[object Object]`**.

`safeErrorResponse` (`src/lib/errors.ts`, used by six routes) computed its message as `err
instanceof Error ? err.message : String(err)`. Supabase's client doesn't always throw a real
`Error`/`PostgrestError` instance — a gateway-level rejection (bad API key, and plausibly other
edge-of-infrastructure failures) comes back as a plain `{ message, hint }` object instead. Plain
objects fail `instanceof Error`, and `String()` on a plain object with no custom `toString` always
produces `"[object Object]"` — dropping a perfectly good `.message` property on the floor.

### The part that matters more than the broken UI text

The same `String(err)` computation fed the **server-side log line**
(`log("error", context, { error: message })`), not just the dev-mode client response. That means
every one of the six routes using this helper was silently logging `"[object Object]"` instead of
the real error, for exactly this class of failure — and this class of failure (auth/gateway
rejections: an expired key, a rotated credential, a misconfigured environment) is precisely the
kind of incident where good server logs matter most and are hardest to reconstruct after the fact.
A bug in a client-facing message is a UX papercut; the same bug in the log line is lost incident
forensics, and it was the *same line of code* causing both.

This had been live in five existing routes (`waitlist`, `dispute`, `tasks`, `reputation`,
`fund-task`) the entire time — `CC-067` didn't introduce it, it just happened to be the first
piece of work whose manual verification path ran straight into a gateway-level Supabase error
rather than a normal query error.

**Lesson:** error-handling helpers that branch on `instanceof Error` will misfire on any thrown
value shaped like an error but not descended from one — which includes a specific, common,
non-hypothetical case: REST/gateway API clients that return plain error objects for
infrastructure-level failures, as distinct from the well-typed error classes they use for
domain-level ones. Check for a usable `.message` property structurally, not just via `instanceof`,
before falling back to `String()`. And more generally: local dev's known-broken credentials (the
ones everyone works around and stops thinking about) are a free, standing test case for exactly
this kind of failure path — this bug was sitting there waiting to be found by anyone who ever
manually clicked through a form far enough to hit it.

---

## 19. The one path we couldn't test was the one path that was actually broken

**Status:** found and fixed 2026-08-08, live re-verification pending — `CC-069`

`CC-055` had sat open since launch prep began, worded deliberately: "not known to be broken. It
is unknown, which for a launch is worse." Every prior test of the wallet flow used the Coinbase
browser extension — an EOA, a seed-phrase wallet — because that's what was installed on every
development machine. The product's actual pitch, the passkey-based Smart Wallet (Base Account),
had never once been exercised end to end, because doing so meant a phone, or a browser with no
extension, and testing kept defaulting to whatever was already open.

Closing `CC-003` (the CSP blocker) finally made a real attempt possible. On a real phone, with a
real Base Account, the flow got further than ever before — a genuine Coinbase login-code email,
a genuine passkey signing prompt at `keys.coinbase.com`, a tap on **Sign**. Then: "Signature
verification failed."

The cause wasn't a phone setting, a browser quirk, or bad luck. `verifyMessage` from viem's
top-level export — used to check the signed registration message — carries this in its own
docstring: *"Only supports Externally Owned Accounts. Does not support Contract Accounts."* Base
Account is a smart contract account (ERC-4337). Its signatures are ERC-6492/ERC-1271, not raw
ECDSA recoverable to the wallet's own address by `ecrecover`. The exact account type the entire
onboarding pitch is built on was, structurally, the one type this check could never accept — and
the identical mistake (`recoverAddress`/`hashMessage`, same EOA-only limitation) was independently
present in the MCP/dispute authentication path too, found by grepping for the same pattern once
the first instance was understood.

### Why "untested" turned out to mean "broken," not "probably fine"

It is tempting to read "nobody has tried this yet" as neutral — an open question, weighted maybe
50/50. It wasn't. The two wallet types this app supports are architecturally different enough
(EOA vs. smart contract account) that code correct for one has no statistical tendency to also be
correct for the other; there was no reason to expect the untested path to work just because the
tested one did. A code review would not have caught this either — `verifyMessage({ address,
message, signature })` reads as obviously correct, type-checks, and the bug is entirely in *which*
function with that exact name and shape got imported.

**Lesson:** when a product has two structurally different ways of doing the same thing (two
account types, two payment rails, two auth methods) and only one has ever been exercised, do not
treat the other as "probably fine, just unverified." Treat it as a coin flip at best, and budget
time to actually flip it — ideally by grep'ing for every other call site sharing the same
underlying primitive (`verifyMessage`, `recoverAddress`) the moment the first failure explains why,
since a mistake made once by not knowing a library's own documented limitation is a mistake very
likely made twice.

---

## 20. The core hire→pay loop has never worked, and correct error handling is why nobody noticed

**Status:** found 2026-08-11, **not yet fixed** — `CC-080`. Published as found, per §8.

The function that pays people has never once succeeded. Not "is fragile", not "fails under load" —
structurally cannot succeed, and has never been able to, for the entire life of the project.

`CarbonEscrow.completeTask` requires `msg.sender == task.agent`
(`contracts/CarbonEscrow.sol:128`), and `createTask` sets `agent: msg.sender` (`:107`). Nothing
server-side calls the contract's `createTask` — the agent funds the escrow client-side from its own
wallet, which both `src/lib/payments/x402.ts:45` and `src/lib/contracts/escrow.ts:6` state plainly.
So `task.agent` is the *agent's* address. But `confirm_task_completion`
(`src/lib/mcp/server.ts:391`) settles the task **server-side as the platform signer**, via
`completeTaskOnChain` (`src/lib/contracts/signer.ts:102`). The platform signer is not the agent, so
every call reverts with `"only agent"`.

Two designs — agent-signed client-side writes, and platform-signed server-side writes — coexist in
the codebase, and the payout path is assembled from one half of each.

### Why it survived, and this is the part worth generalising

**Because the error handling is correct.** `server.ts:389-409` catches the revert, logs
`signer_complete_task_failed`, returns `isError: true` with the chain error text, and returns
*before* `updateTaskStatus`. That is exactly right — it is AUD-005 and AUD-006 doing their job, and
it is why no worker was ever falsely marked paid and no USDC was ever stranded. The failure mode is
genuinely safe.

It is also why nobody noticed. A permanently dead code path, wrapped in well-behaved error handling,
is indistinguishable from a healthy error path that simply hasn't fired yet. Defensive code did what
it was supposed to do and, in doing so, made a structural defect look like a runtime condition.

**Because nothing ever drove the flow far enough to reach it.** Every test to date has been
worker-side: wallet connection, registration, site functionality (`CC-069`, `CC-071`, `CC-055`).
Nobody had pressed the button, because the agent side had no consumer pressing it.

**Because the ticket that would have caught it was too big to start.** `CC-032` existed from
2026-07-25 specifically to run this lifecycle end to end. It sat open for seventeen days with zero
progress, because it was scoped as one ticket covering the happy path, six unhappy paths and three
edge cases across the entire product. That is not a task, it is a wish. It was split four ways during
the triage that found this.

And it was found by *reading a call path during a backlog review*, not by testing — the third defect
in this area found that way, after `CC-059` found `CC-065` and after §17.

**Lesson:** an error branch that has never been observed *not* firing is not evidence the happy path
works — it is the absence of evidence in either direction, and it deserves active suspicion rather
than the comfort its tidiness invites. If a catch block has never been proven unnecessary, treat the
path it guards as unproven. This is a sharper form of §17: there, a correct function had no caller;
here, the caller exists and the call can never succeed. Both survived for the same underlying reason
— nobody had executed the path — and in both cases reading the call graph found in an afternoon what
months of green checks had not.

Corollary, and the cheaper half of the fix: **size a verification ticket so that one person can
finish it in one sitting.** A test ticket spanning an entire lifecycle will be deferred every time it
is considered, and its permanent open status will read as "tracked" rather than "never attempted."

---

## 21. Closing one issue re-introduced the defect another open issue was describing

**Status:** found 2026-08-11, **not yet fixed** — `CC-009`. Published as found.

`CC-009` was filed on 2026-07-25: the waitlist route logs the signup event including the email
address, and `maskMeta` (`src/lib/logging.ts`) masks only values matching
`/^0x[0-9a-fA-F]{40}$/`, so emails pass straight through into the Vercel log stream. Real personal
data, in logs with a different retention and access model to the database. P1, open, unambiguous.

On 2026-08-08, `CC-067` shipped self-serve waitlist unsubscribe and added:

```js
log("info", "waitlist_unsubscribed", { email });
```

Forty lines below the line `CC-009` was already about, in the same file. The defect did not survive
review — it was *recreated* by it. There are now two cleartext-email log sites where there was one.

### Why an open issue was no protection

Because open issues are read when triaging the backlog, not when writing a log line. Nobody greps
`docs/backlog/` before adding an observability call, and there is nothing in the code, the types or
CI that would have objected. The defect class was documented. It was not *controlled*.

Worth noting how well-scrutinised this particular commit was: the same piece of work produced §18's
finding, because someone actually ran it against real infrastructure and chased a `[object Object]`
to its root cause. Care was not the missing ingredient.

**Lesson:** a ticket describing a defect is documentation, not a control. If a defect class can
recur — and "someone adds a log line" always can — the fix has to live in the chokepoint everything
passes through, or in CI, not in prose describing where the defect currently is. `CC-009`'s own Fix
section already said the right thing: *add an email branch to `maskMeta`*. Had that been done when it
was filed rather than left as a described intention, `CC-067`'s new line would have been safe the
moment it was written, and this entry would not exist.

Generalised: when a fix can be made either at the call sites or in the shared helper they all route
through, the helper is not merely tidier — it is the only version that also protects the call sites
nobody has written yet.

---

---

## 22. The ticket's own fix would not have worked, and the fallback is why nobody knew

**Status:** found and fixed 2026-08-11 — `CC-070`

`/api/reputation` is supposed to compute a worker's reputation from on-chain escrow events. It never
once did. Every `getLogs` call in `src/lib/contracts/escrow.ts` defaulted `fromBlock` to `0`, and the
RPC provider caps a single `eth_getLogs` at a fixed block span, so every query failed the moment the
contract was more than a couple of hours old — which is to say, for essentially the whole life of the
project.

### Why nobody knew: the fallback had a reassuring name

The failure was caught and handled. On error, the code fell back to the database and logged:

```
reputation_onchain_fallback
```

That reads like a designed degradation — a fast path and a safe path, with the safe path occasionally
taking over. It was not. The fast path had a 100% failure rate, and the log line was the only evidence,
phrased in a way that made permanent total failure look like an intermittent, anticipated condition.
`CC-070` was only filed because someone happened to read that log line during unrelated live testing of
`CC-069` and wondered why it was there at all.

This is the same shape as §20, from the other direction. There, correct error handling made a dead code
path look like a healthy error path. Here, a correct *fallback* made a dead primary look like a healthy
secondary. In both cases the defensive code worked exactly as designed, and that is precisely what hid
the defect. **A fallback that fires every single time is not a fallback, it is the implementation** —
and nothing in the code, the logs, or the tests distinguished those two cases.

### The part that is genuinely humbling: the fix in the ticket was wrong

`CC-070` diagnosed the problem and proposed a fix: chunk the queries into 2,000-block windows and
aggregate. That is the standard workaround, it sounds right, and it was written by someone looking at
the actual error message. Two things were wrong with it, both found only by measuring before building.

**The limit was not 2,000.** The ticket quoted a live error saying `max block range 2000`. Probed
against the same endpoint two weeks later: 10,000 is accepted, 50,000 is rejected, and the rejection
message says *"eth_getLogs is limited to a 10,000 range"*. Whatever moved — a raised limit, or
different limits behind a load balancer — a hardcoded `2000` would have been wrong immediately, and
wrong in the silent direction: five times slower than necessary, with nothing failing to reveal it.

**Chunking was necessary and nowhere near sufficient.** Base Sepolia was ~45.4M blocks deep. Chunking
from genesis in 10,000-block windows is ~22,700 requests *per query*, and the reputation summary made
four queries. Even bounded at the contract's deploy block — a number nobody had measured, and which
took a binary search over `eth_getCode` to find — it is ~635 requests per query, ~2,540 per dashboard
load, roughly thirteen minutes. **Implementing the ticket's fix as written would have replaced a fast,
loud failure with a slow, quiet one**, and it would have looked like progress: the code would have been
demonstrably "chunked", the tests would have passed, and the endpoint would have timed out instead of
erroring.

The actual fix had to change the *range*, not just the window size: read candidate task ids cheaply
from the database, then read each task's authoritative state from the contract in a single multicall.
Zero event queries on the request path. That was an architectural decision, not a workaround, and it
was only visible once the arithmetic was on the table.

**Lesson, two parts.**

A **fallback needs a success-rate signal, not just a log line.** If the primary path can fail silently
into a secondary, then "how often does the primary actually succeed" has to be observable — a counter, a
`source` field in the response, anything. Otherwise the fallback becomes load-bearing and nobody notices
for months. Note the fix retains a `source: "on-chain" | "database"` field for exactly this reason; that
field existed before and was the one thing that could have surfaced this, if anything had looked at it.

And **a backlog ticket's proposed fix is a hypothesis, not a plan.** These issue files are written to be
handed to a fresh session that starts by reading them, which is their value and also the risk: a
confidently-worded Fix section is very easy to implement without re-deriving whether it is adequate.
The cheapest defence is to put the numbers on the table first — how many requests, over how many
blocks, how long. That took about twenty minutes here and changed the entire design. It is worth
noting that this repo's own convention says to "read the referenced code before proposing a plan";
the missing half is to re-check the *proposed fix* against measurement, not only the problem statement.

## 23. The money contract had no tests at all, and every check we did run stayed green

**2026-08-15, during `CC-082`.**

`CarbonEscrow` was written, deployed to Base Sepolia, granted ownership of real (testnet) funds,
described in `CLAUDE.md`, and referenced by nine backlog issues. It had **zero tests.** Not thin
coverage — none. There was no `test/` directory, `npm test` ran only vitest against `src/`, and
`hardhat.config.ts` loaded the mocha plugin for a suite that did not exist.

This is the substrate under §17, §19 and §20. `completeTask` could never succeed for anyone
(`CC-080`); `expireTask` refunded an agent out from under a worker who had delivered; a single
`nonReentrant`-guarded contract sat holding the entire product premise. Every one of those would
have been caught by a test that simply *ran the happy path once*. Nothing ran it, so nothing caught
it, for the entire life of the project.

The uncomfortable part is that the repo did not feel untested. There were 131 passing vitest tests,
a typecheck, a lint, a security audit, and CI enforcing all of them on every PR. The green checkmark
was real; it just did not cover the contract. **Coverage of the code you wrote tests for tells you
nothing about the code you didn't.**

Two mechanisms, not one, because "write tests" is not a mechanism:

- **Wire the new suite into CI in the same commit that creates it.** An unrun suite decays to a
  worse state than no suite, because it looks like protection.
- **`npm test` is now a half-truth and the docs say so.** There are two suites and two typechecks;
  three of the four did not exist or did not run before this. When a repo has more than one, the
  command that *sounds* comprehensive has to be documented as the one that is not.

**A second, smaller lesson from the same day.** The ABIs in `src/lib/contracts/*-abi.ts` were
maintained by hand. A hand-written ABI missing a function is indistinguishable at runtime from a
contract that does not have one — viem encodes what it is told, the call reverts, and the error
points at the chain rather than at the file. The `reputation-abi.ts` in the tree was in fact an
incomplete subset of the deployed contract, which nobody had noticed because nothing called the
missing parts. They are generated from the compiled artifact now, with a CI drift check. **Anything
transcribed by hand from a build output is a defect waiting for its first reader** — generate it,
and fail the build when the copy is stale.

## 24. The health check verified the component and not the contract it had to satisfy

**2026-08-15, while building `CC-085`.**

`npm run verify:kms` has existed for months and does a genuinely careful job: it fetches the public
key from Cloud KMS, derives the address, signs a message, recovers it, and diffs the two. It hits
real GCP, no mocks. When it says `✓ ALL CHECKS PASSED` the key works.

It could not have detected the most likely way verdict signing actually breaks.

A verdict is an EIP-712 signature, and EIP-712 binds the digest to `(name, version, chainId,
verifyingContract)`. The escrow was redeployed this morning under `CC-082`, which changed
`verifyingContract`. A signer still hashing against the old address would produce cryptographically
perfect signatures that the new contract can never recover to an accepted signer. Separately,
`acceptedSigners` is seeded in the constructor — a redeploy that forgot to seed it, or a key
rotation, leaves a signer that signs beautifully and reverts on every claim. Neither shows up in a
sign-and-recover round trip, because **the round trip never asks the contract anything.**

Both failures are silent in the specific sense `ADR-0003` is about. Post-Amendment 1 the platform
makes no transaction in the settlement path, so there is no failed transaction to alert on; the
system just resolves every task on the liveness default and pays out regardless of evidence.

The generalisable form: **a health check that exercises a component in isolation verifies the
component, not the interface it has to satisfy.** "Can the signer sign" and "will the verifier
accept what the signer produces" are different questions, and only the second one is the property
anybody cares about. The cheap fix was to read `domainSeparator()`, `VERDICT_TYPEHASH()` and
`acceptedSigners(signer)` off the deployed contract and compare them against an independently
computed statement of the same intent — three RPC reads, no credentials required, and it now runs on
a schedule.

Worth noting the shape is §23's again with the polarity flipped. §23 was a component nothing ever
executed. This was a component that *was* executed, regularly, verifying the wrong property — which
is the more expensive version, because the passing check is what stops anyone looking closer.

**Smaller lesson from the same day, for anyone wiring scheduled Actions.** An unset GitHub Actions
secret or variable arrives in the process as the **empty string, not `undefined`**. So `??` does not
select the default: `process.env.MONITOR_WEBHOOK_STYLE ?? "discord"` silently picks the wrong payload
shape, and `BigInt(process.env.RPC_MAX_BLOCK_RANGE ?? 10000)` is `0n`, which turns a chunked
`getLogs` loop into one that never advances. Use `||` for anything sourced from Actions, and validate
after coercion.

## Open questions

Recorded here because pretending to certainty would defeat the purpose of the document.

- Whether the escrow design constitutes a Digital Asset Platform under the Australian framework
  commencing 9 April 2027. Currently well inside the small-scale exemption — under $10m annual
  volume and under $5,000 held per client — but the per-client limb is driven by *concurrent*
  holdings, which the agentic use case stresses in a non-obvious way: thirty simultaneous $200
  tasks from one agent is $6,000. Tracked as `CC-051`.
- Whether reputation staking means anything while `slash()` is never called from anywhere. Tracked
  as part of `CC-037`.
- Whether the rate limiter's in-memory implementation is worth anything across serverless
  instances. It is documented as Redis-backed and is not. Tracked as `CC-020`.
