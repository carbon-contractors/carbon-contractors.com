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
interesting risk. Plenty of it has a 52-test suite, a CI pipeline that fails on high-severity
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

**Status:** found 2026-07-30, fix tracked as `CC-060`, not yet done

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

## Open questions being tracked rather than answered

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
