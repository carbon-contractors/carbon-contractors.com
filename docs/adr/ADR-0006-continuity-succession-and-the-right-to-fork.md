---
id: ADR-0006
title: Continuity, succession, and the right to fork
status: accepted
date: 2026-08-19
accepted: 2026-08-26 - execution parameters set, see Status
amended: 2026-08-26 - D3's mechanism corrected, see Amendment 1
deciders: Aaron Clifft
depends-on: ADR-0001 (D6, D9, A1.2 — why funds already survive the founder), ADR-0002 (D4/D5/D9 — retention vs recoverability)
resolves: CC-091, funds_control_aml_gating.md Track C
blocks: CC-034, CC-039
area: infra
epic: mainnet
---

# ADR-0006 — Continuity, succession, and the right to fork

## Status

**Accepted, 2026-08-26**, with execution parameters. Drafted 2026-08-19 during a
documentation-alignment review; `CC-091` predicted it ("this probably graduates to an ADR") and it
does.

### Execution parameters set on acceptance

| Decision | Parameter |
| :-- | :-- |
| **D1** copyright | **Aaron James Clifft, personally.** AGPL-3.0-or-later at the repository root; `contracts/` MIT. |
| **D2** ownership | **2-of-4 Safe**, four hardware-isolated keys — Tangem cards initialised as **distinct standalone wallets** (**A2**: they arrived as multi-card packs, so this is a setup procedure with a pre-distribution test, not a property of the purchase). Owner separate from the automated HSM verdict signer, confirmed. **Custody: Aaron holds two, in two separate buildings; two family members hold one each.** |
| **D11** custody escalation | Custody escalates on **measured adoption**, not intent, by **rotating the two family slots** to professional or partner holders. Thresholds keyed to the limbs `verify-concurrent-escrow.mjs` already measures. |
| **D3** arbitration clock | **A fixed 7-day arbitration window in the contract bytecode, before the mainnet deploy, running from the moment the task is disputed.** An unresolved arbitration defaults to the **worker**, claimed as a pull payment. Mechanism corrected by **Amendment 1** — D3 as written could not start its own clock. |
| **D5 / D7** continuity | `docs/BCP-DR.md` and `chain-constants.json` live **in-repo**. No dependency on any private workspace. |
| **D8** backups | The DB backup posture **excludes task content and evidence**, so `privacy.md`'s deletion guarantee survives a restore. |

**Two things the parameters do not settle, and both are load-bearing.** They are carried forward in
Open items rather than treated as closed:

1. **Four Tangem cards are only a 2-of-4 if they are four keys.** Tangem sells cards as a set that
   *shares one seed* by default — a set restored from one backup is one key wearing several plastic
   coats, and a multisig built on it has the security of a 1-of-1 while looking like a multisig on
   Basescan. **Buying the cards separately closes this by construction** rather than by getting a
   setup flow right, which is the decided approach. It is still **verified on-chain** — four
   unrelated owner addresses with no shared derivation — because "we bought them separately" is a
   claim and the chain is evidence.
2. **Custody is decided (D2), and 2-of-4 removes the estate-discovery dependency entirely.** Aaron
   holds two keys in two separate buildings; two family members hold one each. **The two family keys
   alone reach threshold**, so succession no longer requires an estate to find, recognise and
   correctly handle one of Aaron's cards. What remains is not cryptographic but human: both family
   holders are non-technical, and a key that has never been signed with is a key that exists on
   paper. D2 carries the rehearsal and estate-packet requirements that answer it.

**Two decisions confirmed by Aaron on 2026-08-19, ahead of the rest:**

- **D1 — the copyright holder is Aaron James Clifft, personally.** Not a company. The licensing right
  stays with the author, and succession of that right is an estate question, not a corporate one.
- **D3 — accepted, including the scope it adds to `CC-034`.** The arbitration deadline is bytecode,
  so it lands in the mainnet deploy or it does not exist in v1. Aaron accepted that scope creep
  explicitly rather than deferring it.

The remaining decisions stay `proposed` — D2's key-holders in particular are unresolved and are the
reason this ADR is not yet accepted in full.

---

## Context

The stated goal is that this project *can exist in perpetuity after I am gone, as long as others see
value in it*. That is three separate problems wearing one coat, and they have different answers:

| Layer | Question | Current state |
| :-- | :-- | :-- |
| **Funds** | can money still move if the operator vanishes? | ✅ except tasks in dispute (`CC-091`) |
| **Service** | can the site keep running, or be re-hosted? | ❌ account-bound, no runbook in the repo |
| **Right** | may anyone legally continue it? | ❌ no licence file existed until 2026-08-19 |

The third is the one nobody had noticed, and it silently voids the other two: a public repo with a
bare `README.md` declaration of "MIT" and no `LICENSE` file gives a would-be successor nothing they
could rely on. Perpetuity is a legal property before it is a technical one.

The funds layer is already in good shape, and **not by luck**. `ADR-0001` A1.2 made settlement
pull-payment and D6 made liveness default to the worker, both to stop platform inaction deciding
outcomes. Bus-factor resistance fell out for free. `CC-091` states the consequence and it is worth
restating as a standing constraint: **any future change that puts the platform back in the settlement
path re-creates this exposure.**

The one genuine stranding case is `Disputed`/`Arbitrating`: `resolveDispute` is `onlyOwner`, there is
no timeout, and no fallback. That is QuadrigaCX scoped to disputed tasks, and it is a **bytecode**
problem — so it is fixable before the mainnet deploy and not after.

---

## Decision

### D1 — The project is licensed to be continued: AGPL-3.0-or-later, with `contracts/` staying MIT

`LICENSE` carries the verbatim AGPL-3.0 text. `COMMERCIAL.md` carries the dual-licence offer and the
inbound contribution grant.

- **AGPL rather than MIT** because MIT lets a successor take the project private. The fork would
  survive; the verifiability would not — and verifiability *is* the product (`ADR-0001` D9). Section
  13 is the operative clause: run a modified copy as a network service, publish its source to that
  service's users.
- **`contracts/` stays MIT.** Copyleft over deployed, source-verified bytecode is close to
  meaningless, and the protocol wants permissive integration by wallets, agent frameworks and
  competing front-ends. The thing worth protecting with copyleft is the platform implementation —
  checker, verdict service, app, MCP server.
- **Dual licensing requires an inbound relicensing grant from every contributor**, asked for before
  merge, not after. Recorded in `COMMERCIAL.md` as a DCO-style statement until a real CLA is needed.
- **Prospective, not retroactive.** Whatever the prior README declaration granted, it granted. Say so
  plainly rather than restating history (`CC-056`).

**Accepted 2026-08-26 — copyright is retained by Aaron James Clifft personally**, not by North Metro
Tech. That closes this ADR's open item. Consequences worth naming: the estate inherits the copyright
directly rather than through a company, the inbound contribution grant runs to a natural person, and
any later assignment to an entity is a deliberate act with its own paperwork rather than a default.
The AGPL grant itself needs no further advice; the **terms of the commercial alternative still do**,
which is why `COMMERCIAL.md` offers a negotiation rather than a priced licence.

### D2 — Contract ownership moves to a multisig before mainnet, and the owner is not the verdict signer

One HSM key currently owns the contracts *and* is the accepted verdict signer. `CC-090` proposed
separating them and was rated P2 on the reasoning that separation buys nothing against a *compromise*
while both roles sit on one key. Succession is a second, independent and stronger argument for the
same change, and it re-rates `CC-090` to P1.

- **Owner → a multisig.** The founder does not hold every key. *(Accepted as 2-of-4 — see below.)*
- **Verdict signer stays a single HSM key**, because it needs to sign automatically and holds no
  custody. Losing it fails safe: no verdicts → everything resolves to workers after the review window
  (`ADR-0001` D6).
- Naming the other two key-holders is the hard part, and it is a decision, not an engineering task —
  see open items.

**Accepted 2026-08-26 — the architecture is a 2-of-4 Safe over four hardware-isolated keys**,
implemented as Tangem cards **initialised as distinct standalone wallets**. (Amended 2026-08-31: the
original text said "bought separately and initialised as distinct standalone wallets". Only the
second half is the requirement — see A2.)
Separation of the contract owner from the automated HSM verdict signer is confirmed and is now a
stated invariant rather than an aspiration: `verify-contract-owner.mjs` and `verify-signer.mjs`
already assert each half, and together they assert the separation.

**The failure mode to design against is a multisig that is not one.** A Tangem set restored from a
single seed presents several cards and one key. **Amended 2026-08-31 — see A2: the cards were bought
as multi-card packs, so this is a procedure to execute rather than a property of the purchase.** The
acceptance test is on-chain and not procedural — four Safe owners at four addresses with no shared
derivation, checked before any value moves — plus a cheaper pre-check that needs no Safe at all.
`CC-090` carries both.

**Custody, decided 2026-08-26: 2-of-4.** Recorded as roles and separation only — **never
locations**. This file is in a public repository (`CC-056`); writing down where a key lives would
publish a burglary map for a wallet with arbitration authority over live escrow. Locations belong with
the estate documents.

| Slot | Holder | Notes |
| :-- | :-- | :-- |
| 1 | Aaron — daily driver | The one most likely to travel with him |
| 2 | Aaron — secured, **a different building from slot 1** | Geographic separation is the point |
| 3 | Family member A | Non-technical. **Transitional slot** — see D11. |
| 4 | Family member B | Non-technical. **Transitional slot** — see D11. |

**Why 2-of-4 rather than 2-of-3, given the same people.** Three properties, and the second closes
this ADR's central problem:

1. **It tolerates losing two keys, not one.** Any two survivors reach threshold.
2. **The two family keys alone reach threshold.** Succession no longer depends on an estate finding,
   recognising and correctly handling one of Aaron's cards. That was the entire residual under a
   2-of-3 arrangement and it is now gone.
3. **Aaron can still act alone**, holding two — so day-to-day operation needs no coordination.

| Scenario | Reachable | Threshold |
| :-- | :-- | :-- |
| Aaron incapacitated, daily key lost with him | slot 2 + either family, or both family | ✅ |
| Fire at either of Aaron's buildings | three keys remain | ✅ |
| **Aaron gone, estate locates nothing** | **family A + family B** | ✅ |
| Both family cards lost | Aaron's two | ✅ |
| Any two of four lost | remaining two | ✅ |
| Any **three** of four lost | one | ❌ |

**A copy is not a key.** Two people holding duplicates of the same seed are one key and can never
reach threshold together — which is why slot 4 is a separately-purchased card rather than a backup of
slot 3. Recorded because "give a copy to someone else" is the intuitive move, and it buys availability
without buying a holder.

**The residual is capability, not cryptography, and it now sits exactly on the succession path.** Both
family holders are non-technical, and they are the two who must act together if Aaron is gone:

- **A 2-of-4 signature executed by the two family keys alone**, on testnet, before `CC-090` closes.
  Not a signature that merely includes them — the succession path is family-only, so that is the path
  that has to be proven. Anything less leaves succession as theory.
- **An estate packet**, held with the will and not in this repo: that the keys exist, what a Tangem
  card looks like, what it controls, who the other holders are, and how to reach the signing flow.
  The likeliest failure is not that nobody finds a card — it is that somebody finds one and discards
  it as an expired loyalty card.

**Succession runs to a minor.** Control is intended to pass to Aaron's son, currently four, with his
mother as proxy until he is old enough. That is a ~2040 horizon — longer than the ENS registrations,
longer than a card's practical life, and possibly longer than Tangem as a company. It needs
**periodic re-verification** on the same annual cycle as the domain and ENS renewals, and it needs to
exist as a **legal instrument**, which is this ADR's remaining open item and not an engineering task.

### D3 — Arbitration gets a clock, and its default follows D6

The stranding case is closed in the contract, not in a runbook.

- `beginArbitration` sets an **arbitration deadline**, bounded by the contract in the same way the
  review window is (`CC-082` precedent: agent-set, contract-bounded).
- If the deadline passes with no `resolveDispute`, the task becomes claimable **by the worker**, on
  the same pull-payment mechanism as `releaseAfterReview`.
- Worker-default rather than refund-default for the reason `ADR-0001` D6 already gives: the
  alternative hands the platform a griefing lever by inaction, and here it would also mean the
  operator's death pays the agent.

**Accepted 2026-08-26 — the deadline is embedded in the contract bytecode before the mainnet deploy,
and an unresolved arbitration defaults to the worker via pull payment.** Both halves matter:

- **In bytecode, not in a job.** A clock enforced by a scheduled task is a clock that stops when the
  operator does, which is the exact scenario this ADR is about. `ADR-0001` A1.1 removed platform
  liveness from settlement; a runbook-enforced deadline would put it back.
- **Worker-default, pull payment.** Same mechanism as `releaseAfterReview`: the worker claims, the
  platform transacts nowhere. `ADR-0001` D6's reasoning carries over unchanged — a refund-default
  would mean the operator's death pays the agent, and would hand the platform a griefing lever it
  exercises by doing nothing.

**Amendment 1 (2026-08-26) changes how this is built.** Two things in the paragraphs above do not
survive contact with the state machine: the clock cannot start at `beginArbitration`, and it must not
be a window the arbitrator sets for itself. The *decision* — a bytecode clock defaulting to the
worker — stands unchanged. Read A1.1–A1.3 before implementing.

This is a contract change. It lands with the mainnet deploy (`CC-034`) or it does not land in v1.

### D4 — `resolveDispute` stays, behind the multisig, and every use is published

`funds_control_aml_gating.md` Track C names three options: leave it, timelock it, renounce it. This
ADR chooses **keep, constrain, and disclose**.

- Keeping it: the checker will have bugs, and a version discovered to be broken (`ADR-0001` A2.4)
  needs a hand on the wheel. Renouncing is defensible only after the algorithmic path has a long
  clean production record — which is a v2 conversation, not a launch one.
- Constraining it: multisig (D2) makes it non-unilateral in principle, which is the actual bar Aaron
  set for himself, distinct from the regulatory bar where an owner-gated override is ordinary.
- Disclosing it: every use published in the repo, with the reasoning, at the time. An override nobody
  can see is indistinguishable from discretion.

### D5 — A continuity register exists, in the repo

`docs/BCP-DR.md`, written for a stranger rather than for Aaron. It records, per asset: what it is, who
can reach it, what it costs, when it renews, and what breaks first if it lapses — domain and
registrar, DNS, Vercel, Supabase, GCP/Cloud KMS, the GitHub org, the npm org. No credentials, only the
map. **Nothing in it may depend on a private workspace**, which is the flaw in the current DR plan
living only in a Claude project.

**Accepted 2026-08-26 — in-repo, with no dependency on a private workspace.** `docs/BCP-DR.md`
exists (seeded 2026-08-26 with the two ENS registrations) and `chain-constants.json` is added in the
same change. The constraint is the point: a continuity register that lives in a Claude project, a
password manager note or anyone's head is not a continuity register.

### D6 — Discoverability failover: DNS for humans, ENS for agents

- The registrar sits outside the hosting provider, with auto-renew, registrar lock, and a recovery
  contact that is **not** an address on the domain being recovered.
- DNS is already fronted by Cloudflare rather than the host, so repointing does not require the host
  to be reachable. Confirm and record it; it converts an open worry into a stated control.
- **An ENS name with a `url` text record is the canonical machine-readable pointer**, resolved at
  runtime by the MCP client rather than hard-coded. An agent holding a bookmarked URL has exactly the
  problem a bookmarked URL gives a human, and the fix belongs in `CC-044`.
- The "if the site is down, look here" announcement must not depend on the infrastructure it is
  announcing the failure of. `ADR-0003` D5 already makes this argument for alerting paths; it is the
  same argument.

### D7 — The re-host bundle is a deliverable, not an intention

Three artefacts, all in-repo, that together let a stranger stand the platform back up and let anyone
check that they did it honestly:

1. **`chain-constants.json`** — per network: escrow address, deploy block, USDC address, accepted
   verdict signers, `checkerHash`, canary digest. Today these are scattered across `.env.example`,
   `CLAUDE.md` hazard notes and ticket bodies, which is also why they keep going stale.
2. **`docs/BCP-DR.md`** — the runbook: clone, configure, deploy elsewhere, repoint, announce.
3. **A protocol reimplementation spec** — tool schema, EIP-712 domain and typehash, state machine,
   checker bundle format. The ADRs record decisions *for the operator*; nothing currently tells a
   third party how to build an equivalent server, and that is what "the protocol outlives the
   operator" requires.

### D8 — Backups hold registration data; task content is never in a backed-up store

Resolves `ADR-0002`'s open item ("storage target for task content: unbacked table, separate store, or
none") from the DR side, where it becomes unavoidable.

- **Registration and reference data** (`humans`, categories) is backed up, exported off-vendor on a
  schedule, and restore-tested at least once before mainnet.
- **Task content** — descriptions, acceptance-spec preimages, verdict breakdowns — lives in storage
  that is **not** backed up and not covered by point-in-time recovery, per `ADR-0002` D9's preferred
  option. Partitioned by settlement week, dropped whole.
- **A restore must not resurrect deleted task content.** If it can, the published deletion claim in
  `privacy.md` is false, and a disaster-recovery action becomes a privacy breach.
- `verify-retention` (`ADR-0003` D2) therefore asserts the **backup posture** as well as the live
  tables. Checking live rows only would pass throughout the failure.

**Accepted 2026-08-26 — backups exclude task content and evidence.** The deletion guarantee in
`src/legal/privacy.md` and `/learn` module 7 is only true if a restore cannot resurrect what
retention deleted. `ADR-0002` D9 already names this as one of the three traps that would make the
claim false; D8 is now the operative rule rather than a caution. Registration data is backed up;
task content is not, which also means task content has no restore path — accepted deliberately,
because the alternative is a backup that silently un-deletes.

### D9 — The registry gets its own integrity mechanism, because commitments do not cover it

`ADR-0001` D4 gives task and money state tamper-evidence. The whitepages has none: a replacement
backend could rewrite rates, re-categorise workers or drop them, and pass every monitor. Reputation
survives a rebuild (`ADR-0002` D5, derived from events); the registry does not.

**Workers sign their own profile record**, and the signature is stored beside it. Verification then
requires no trust in whoever runs the database, needs no contract change, no gas, and no new
on-chain data. An optional periodic Merkle root of the registry can follow if it earns its cost.

Decide before the registry contains real workers — retro-fitting signatures to rows nobody can
re-sign is the expensive version of this.

### D10 — Who declares a failover, and the residual named

A DR plan only one person can execute has a single point of failure one layer above the
infrastructure. The trigger, the executor and their independent access are recorded in
`docs/BCP-DR.md`. **If the honest answer is "only Aaron", that is written down as the residual risk
rather than left implied** — the same treatment `Security-Trust-Disclosure.md` now gives the oracle
role.

---

### D11 — Custody escalates on measured adoption, not on intent

A custody arrangement sized for a sole trader stops being appropriate at some scale, and "we will
revisit it when it feels right" is how it never gets revisited. So the escalation has thresholds, in
the same shape as `ADR-0007` A1.1's exit test: published in advance, keyed to numbers something
already measures.

**Escalation is a rotation, not a re-architecture.** Slots 3 and 4 are **transitional by design**:
when the platform is large enough to need more than one person, those two keys pass to partners or a
professional key-holder service. The threshold stays 2-of-4 and the Safe is never rebuilt — Safe
owners are swappable, so escalation is a key swap that can be rehearsed like any other change.

> **Rotate while the outgoing holder is still reachable.** Swapping an owner is itself a 2-of-4
> transaction. Waiting until a holder is unavailable turns a routine change into a recovery.

**The trigger is aggregate value under the platform's arbitration authority**, not per-task funding.
It is a proxy for how much rides on one person's keys — and deliberately anchored to the limbs
`verify-concurrent-escrow.mjs` already replays the event log to compute, which are the AU Digital
Assets Framework small-scale exemption limbs (**$5,000 peak concurrent per funding agent**, **$10m
trailing-365-day volume**, framework commencing **2027-04-09**, `CC-051`).

**Tier 1 — rotate one family slot to a professional key-holder service.** Any one of:

- aggregate peak concurrent escrow **≥ $25,000 USDC** (≈ five agents at the per-client limb)
- trailing-365-day funded volume **≥ $250,000 USDC** (2.5% of the regulated limb)
- **≥ 50** distinct workers with funds in flight

sustained **30 consecutive days**.

**Tier 2 — rotate the second family slot to a partner: governance, not only custody.** Any one of:

- trailing-365-day funded volume **≥ $1,000,000 USDC** (10% of the limb)
- aggregate peak concurrent escrow **≥ $100,000 USDC**

sustained **90 consecutive days**, mirroring `ADR-0007` A1.1's horizon.

**Two backstops that do not depend on volume**, because both failure modes are invisible to a value
threshold:

- **2027-04-09.** If the platform is live and not clearly exempt when the framework commences, Tier 1
  fires regardless of volume. A regulatory date is not a metric and will not trip one.
- **Key liveness.** If either family key goes untested for **12 months**, that is its own escalation.
  A stale key is worse than a missing one because it is counted — and under 2-of-4 the two family
  keys *are* the succession path, so an untested one silently removes it.

**Why fractions of the regulatory limb rather than invented numbers.** By the time either limb is
actually approached the platform is regulated, and needing a partner is the least of the problems.
The limbs are the only figures in this project that already mean "large enough to matter", and
`verify-concurrent-escrow.mjs` already computes both — so the trigger is measured rather than
estimated.

**Two of the three Tier metrics are already reported today.** That monitor replays the event log and
prints `peak concurrent, all agents` (a true aggregate — it tracks the maximum of the summed balance
across every agent, not the largest per-agent peak) alongside `funded, trailing 365 days`. So Tier 1
and Tier 2 can be evaluated by reading its existing output.

**What is missing is small and specific:** the **distinct-worker count**, since the monitor keys on
funding agents rather than workers, and the Tier thresholds themselves as *warn* conditions. Both are
additions to the same replay — `TaskCreated` already carries the worker address.

**These are governance triggers, not invariants.** The monitor warns when one is crossed; it must not
fail, because a monitor that goes red on commercial success trains its reader to ignore it.

## Rejected alternatives

| Rejected | Why |
| :-- | :-- |
| Stay MIT | Lets a successor take the project private; loses the verifiability that is the product |
| AGPL over `contracts/` too | Copyleft over verified on-chain bytecode is near-meaningless and taxes exactly the integration the protocol wants |
| Renounce `resolveDispute` now | No recourse if the checker traps funds on a bug; defensible only after a long clean record |
| Timelock alone, single key | A timelock delays a unilateral act; it does not make it non-unilateral, which is the stated bar |
| No arbitration timeout | Preserves the one genuine stranding case — QuadrigaCX scoped to disputed tasks |
| Arbitration timeout refunds the agent | Makes the operator's unavailability pay the agent, and re-creates the D6 griefing lever inverted |
| Multisig on the verdict signer | Verdicts must sign automatically; losing the signer already fails safe |
| Task content included in backups "for safety" | Directly falsifies a published deletion claim; DR must not become a retention exception |
| DR plan lives in the founder's private workspace | The document describing how to re-host from the public repo must be reachable from the public repo |

## Amendment 1 — 2026-08-26 — the arbitration clock starts at the dispute, and is a constant

D3 was accepted with its mechanism borrowed from the review window: *"`beginArbitration` sets an
arbitration deadline, bounded by the contract in the same way the review window is."* Setting the
bound values exposed two problems with that sentence. The decision is unaffected; the mechanism is
replaced.

### A1.1 — The clock starts at `disputeTask`, not at `beginArbitration`

`beginArbitration` is `onlyOwner`, and `CarbonEscrow.sol` documents `Disputed → Arbitrating` as
**"a marker, not a gate: resolveDispute works from either state"**. So it is optional. An owner who
simply never calls it never starts a clock, and the task sits `Disputed` indefinitely with the escrow
held — **which is the exact stranding case D3 exists to close.** A deadline whose start is controlled
by the party it constrains is not a deadline.

So the clock starts when the task *becomes* disputed:

- `disputeTask` records `disputedAt`. It is callable by **either party** (`ADR-0001` D2), so no single
  party can withhold the clock by inaction.
- `beginArbitration` keeps its marker role for observability — an off-chain observer can still tell
  "raised" from "being worked on" — but stops being load-bearing.

### A1.2 — It is a constant, not a window the arbitrator sets

The review window is agent-set within bounds because a $5 photo task and a multi-day job do not want
the same number, and because the agent is not the party the clock protects against. Neither holds
here. The arbitrator would be choosing **its own deadline**, which is the same structure as the
defect `ADR-0001` D2 removed — one party holding both sides of a decision.

`ARBITRATION_WINDOW` is therefore a contract constant. No discretion, nothing to stall with, and one
fewer argument to get wrong at a moment when a dispute is already live.

`ADR-0007`'s tiers may eventually want a tier-dependent window — a T2 panel needs longer than a T1
single reviewer. That is a contract change whichever shape is chosen today, so nothing is foreclosed.

### A1.3 — Seven days

**`ARBITRATION_WINDOW = 7 days`.**

The number that matters is not the window, it is what a worker experiences, because the clocks stack:

| | Post-delivery wait, worst case |
| :-- | :-- |
| `MAX_REVIEW_WINDOW` (14d) + **7d** | **21 days** |
| `MAX_REVIEW_WINDOW` (14d) + 14d | 28 days |

Twenty-one days is already a long time to be unpaid for a small job, and that is the *ceiling* — it
requires an agent that chose the maximum review window, disputed, and then an arbitration that ran
full length.

- **Long enough** for the arbitration that actually exists: the owner reading evidence and running
  `scripts/admin/verify-escrow-lifecycle.ts`, or `ADR-0007`'s T1 single reviewer.
- **Short enough** that stalling is not a strategy and the tail stays proportionate to the work.
- **Deliberately half of `MAX_REVIEW_WINDOW`.** The platform is held to a tighter clock than the
  agent, and that asymmetry is the right way round: the platform chose to run a dispute mechanism,
  and by the time arbitration starts the worker has already delivered *and* waited out a full review
  window.

### A1.4 — The deadline binds the arbitrator, not only the worker

*Added 2026-08-28, during implementation. A1.1–A1.3 specified when the clock starts, that it is a
constant, and how long it runs. They did not say what happens to `resolveDispute` after it expires,
and the answer is not free — leaving it callable would have undone most of A1.1.*

An owner who can still rule at any later time is not constrained by a deadline. Worse, the two
routes would be live simultaneously, and the owner would hold the faster one: watch for the worker's
`releaseAfterArbitration`, and front-run it with `resolveDispute(false)` to refund the agent. The
clock would then constrain nobody and would read, from the outside, as though it did.

So `resolveDispute` reverts `ArbitrationWindowClosed` once the window has elapsed. The two routes
are **exact complements** — precisely one of them is available at any timestamp — which is the same
shape `disputeTask` and `releaseAfterReview` already have either side of the review deadline, and
for the same reason.

`beginArbitration` is gated the same way. Its only product is the `ArbitrationBegun` event, and
emitting that on a task which has already timed out would tell an observer "being worked on" about
a task past being worked on.

**What this costs the owner**, stated plainly rather than buried: an arbitration decided at day 6
and 23 hours but *mined* at day 7 fails. If the ruling was for the worker nothing is lost, because
the timeout route pays the worker too — it is re-routed, not reversed. If the ruling was for the
agent, it is lost. That is deliberate; seven days was the whole allowance, and an arbitrator who
needs a 169th hour has a scheduling problem, not a rights problem.

**What this costs to build** (scoped into `CC-034`, since it is bytecode):

- A `uint64 disputedAt` field. Slot 1 is 30 of 32 bytes used, so it takes a new slot — but it is only
  written by `disputeTask`, so `createTask` never pays for it.
- A worker-claim path for the timeout, reusing `_payOut` with a new `CompletionRoute` member appended
  (appending is safe; the enum is only ever read from events).
- Tests for the boundary in both directions, and for the case A1.1 exists to prevent: **a dispute
  where `beginArbitration` is never called must still time out.**

## Amendment 2 — 2026-08-31 — the custody property is initialisation, not purchase

D2 was accepted with the words "Tangem cards **bought separately**, so a shared seed is impossible by
construction." The hardware was ordered on 2026-08-31: **four cards, as multi-card packs, not four
separate single-card orders.** ~A$130 total, shipping from the US, expected around 2026-09-17.

The decision is unaffected — still a 2-of-4 Safe over four hardware-isolated keys, same custody
table. What changes is that the property is no longer guaranteed by the procurement, and three
statements in this ADR, `CLAUDE.md`, `docs/BCP-DR.md` and `chain-constants.json` said it was. All four
are corrected in the same commit as this amendment.

### A2.1 — The requirement was always independent initialisation

"Bought separately" was never the property. It was a **proxy** for the property, chosen because it
was checkable at order time — before there was any hardware to test. The property is that the four
keys derive from four independent seeds.

The proxy is gone. The requirement is not:

**Each card is initialised as its own standalone wallet, with the app's backup/link step skipped.**

The vendor's account is that cards in a pack become linked only when a second card is registered as a
backup, and that skipping that step leaves each card an independent wallet. That is plausible and
consistent with how the hardware works. It is also **vendor-reported and unverified by us**, and it
converts a fact about the boxes into a procedure a person executes once, under an app that actively
prompts toward the backup flow. Procedures executed once by a person are exactly what this ADR
distrusts elsewhere.

So it needs a test, and it turns out to need it earlier than D2 assumed.

### A2.2 — The test moves earlier and gets cheaper

D2's acceptance test was on-chain: four Safe owners at four addresses. That still stands as the final
gate — the Safe's owner set is what actually enforces the threshold, so it is the only thing that
proves the arrangement rather than the intent.

But it is no longer the *first* test, and it should not be. **Four distinct addresses can be read
straight off the four cards** — tap each, read its address — before a Safe exists, before a
transaction, on day one of delivery. That check costs nothing and it is available at the only moment
when the answer is still cheap to act on.

Ordering, which is the actual content of this amendment:

1. Initialise each card standalone, backup/link skipped.
2. **Read all four addresses. Four distinct values, or stop.** A repeat means two cards share a seed.
3. Factory-reset and redo any pair that failed. Confirm the reset procedure against Tangem's own
   documentation first — this ADR is not the authority on their hardware.
4. Assign cards to slots per A2.3, then distribute.
5. Create the Safe, verify four owners on-chain, transfer contract ownership, and only then fund.

Steps 2 and 3 are reversible. Everything from step 4 is not, in practice: the cards are then in
different buildings and in non-technical hands, and getting them back to redo the setup is a
different kind of problem from tapping four cards on a desk.

### A2.3 — Cross-pack slot assignment, as a free hedge

Assign cards so that **no two cards from the same pack land in either load-bearing pair.**

| Slot | Holder | Card from |
| :-- | :-- | :-- |
| 1 | Aaron — daily driver | pack A |
| 2 | Aaron — secured, different building | pack B |
| 3 | Family member A | pack A |
| 4 | Family member B | pack B |

Two pairs carry the arrangement: **Aaron's own two**, so he can act without coordinating, and
**family A + family B**, which is the succession path and D2's entire reason for choosing 2-of-4 over
2-of-3. Under this assignment both cross packs.

The hedge is free. If initialisation worked, pack membership means nothing and the assignment is
arbitrary. If it silently did not, the two pairs that matter still reach threshold and what degrades
is loss tolerance — both cards of one pack can no longer be lost together — rather than succession.

**The wrong assignment fails in precisely the case 2-of-4 exists to cover.** Two family cards from
one pack are one signer. They can never reach threshold together, the estate-discovery dependency
this ADR removed comes straight back, and nothing about the Safe would look wrong from outside.

Recorded as a decision rather than a note because it cannot be applied retroactively, and because the
intuitive assignment — give the family the two cards that came in the same box — is the failing one.

## Consequences

- `CC-090` re-rates P2 → P1 and merges with D2.
- `CC-091` becomes the implementation ticket for D2/D3/D5/D10 rather than an open design question.
- **`CC-034` gains contract-level scope**: the arbitration deadline (D3). It is bytecode, so it is
  now or never for v1.
- `ADR-0002` gains an amendment for D8, which answers one of its open items from the DR side.
- **`ADR-0007` Amendment 1 depends on D3.** Its retroactive-audit model assumes a payout that has
  already finalised, which is exactly what D3's timeout produces.
- New work: `chain-constants.json`, `docs/BCP-DR.md`, the protocol spec, profile signing (D9), ENS
  record (D6). None of it blocks the Sepolia lifecycle tests.
- **The published claim set grows.** `terms.md` now says funded tasks survive the platform; that must
  stay true, which makes D3 load-bearing on copy as well as on funds.
- **Amendment 2 adds two `CC-090` closing conditions** that were previously implicit in the
  procurement: the four-address pre-check before distribution, and the cross-pack slot assignment.
  Neither is expensive; both are unrecoverable if skipped and only discovered later.

## Open items

- ~~**Copyright holder: Aaron personally, or North Metro Tech.**~~ → **Aaron James Clifft
  personally**, accepted 2026-08-26 (D1). The commercial *terms* still want a lawyer; the AGPL grant
  does not.
- ~~**Who holds the multisig keys.**~~ → **Decided 2026-08-26** (D2): 2-of-4, Aaron holding two in
  two separate buildings and two family members holding one each. The estate-discovery dependency is
  gone, because the two family keys reach threshold alone. **Hardware ordered 2026-08-31, expected
  ~2026-09-17** — see A2 for what the purchase structure changed. Three consequences remain, none of
  them the choice itself:
  - **The family-only rehearsal.** A 2-of-4 signature by the two family keys and nothing else, on
    testnet. Until that exists, succession is designed and untested. `CC-090`.
  - **The estate packet** — the paper that makes the arrangement legible to people who did not build
    it. A deliverable, not a decision, and it does not live in this repo.
  - **The legal instrument.** Succession runs to a minor with a proxy; that is a will, not a repo
    artefact, and it is the live half of the "law rather than code" item below.
- ~~**Arbitration deadline bounds.**~~ → **Set 2026-08-26** by Amendment 1: a fixed
  `ARBITRATION_WINDOW` of **7 days**, running from `disputeTask` rather than `beginArbitration`, and
  a constant rather than a settable window. The `MIN`/`MAX` shape was abandoned with the reasoning in
  A1.2 — the arbitrator must not set its own deadline.
- **Backup mechanism for the D8 split** — which Supabase facility (or replacement) can back up
  registration data while excluding the task-content columns. D8 states the requirement; nothing yet
  implements it, and a backup configured wrong is indistinguishable from one configured right until a
  restore.
- **Does any of this need to exist in law rather than in code?** An estate cannot inherit a key it
  cannot find. Out of engineering scope.
- **Supabase Scenario B target** — self-hosted Postgres or an alternative managed provider — remains
  undecided from the DR plan, and D8 narrows but does not answer it.

## Handover — implementation order

1. ~~**`LICENSE`, `COMMERCIAL.md`, README licence line** (D1).~~ **Done 2026-08-26.** Entity set to
   Aaron James Clifft personally; `LICENSE` AGPL-3.0 verbatim; `contracts/LICENSE` MIT added so the
   carve-out is a file and not only an SPDX header.
2. ~~**`docs/BCP-DR.md` and `chain-constants.json`** (D5, D7).~~ **Done 2026-08-26.**
3. **Restore test and the backed-up/unbacked split** (D8), with a scope line on `CC-087`.
   *Requirement accepted; nothing implements it yet.*
4. **Multisig ownership and signer separation** (D2, `CC-090`) — before `CC-034`. Scoped into both
   tickets 2026-08-26. **Custody decided (2-of-4)**; the remaining gates are the family-only
   rehearsed signature and the on-chain check that four cards are four keys.
9. **Worker count and Tier warn thresholds on `verify-concurrent-escrow.mjs`** (D11). The aggregate
   peak and trailing-365-day volume are already reported; only the distinct-worker count and the
   warn conditions are new. Warn, never fail — a monitor that goes red on commercial success trains
   its reader to ignore it.
10. **The estate packet** (D2) — outside the repo, and the only item here that cannot be done by
   writing code.
5. ~~**Arbitration clock in the contract** (D3 + Amendment 1) — in the mainnet deploy, with tests.~~
   **Written 2026-08-28**: `ARBITRATION_WINDOW`, `Task.disputedAt`, `releaseAfterArbitration`,
   `arbitrationDeadline`, the `resolveDispute`/`beginArbitration` gates from A1.4, and 15 contract
   tests — including the one A1.1 exists for: *a dispute where `beginArbitration` is never called
   must still time out*. Six mutations of the guards were checked and all six fail a named test.
   **Deployed nowhere.** It is bytecode, so it reaches Sepolia and then mainnet only through
   `CC-034`'s redeploy; until then the live contract has no arbitration clock and
   `chain-constants.json` records that.
6. **Profile signing** (D9) — before the registry holds real workers.
7. **ENS record and the announcement channel** (D6), folded into `CC-044`'s rewrite.
8. **Protocol spec** (D7) — after `CC-092`, when the surface it describes exists.

Related: `CC-091`, `CC-090`, `CC-034`, `CC-039`, `CC-087`, `CC-044`, `CC-056`, `ADR-0001` (D6, D9,
A1.2), `ADR-0002` (D4, D5, D9), `ADR-0003` (D5), `docs/Key-Compromise-Recovery.md`,
`docs/funds_control_aml_gating.md`.
