---
id: ADR-0006
title: Continuity, succession, and the right to fork
status: accepted
date: 2026-08-19
accepted: 2026-08-26 - execution parameters set, see Status
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
| **D2** ownership | **2-of-3 Safe**, three hardware-isolated keys — Tangem cards **initialised as distinct standalone wallets**. Owner separate from the automated HSM verdict signer, confirmed. |
| **D3** arbitration clock | **Bounded arbitration deadline in the contract bytecode, before the mainnet deploy.** An unresolved arbitration defaults to the **worker**, claimed as a pull payment. |
| **D5 / D7** continuity | `docs/BCP-DR.md` and `chain-constants.json` live **in-repo**. No dependency on any private workspace. |
| **D8** backups | The DB backup posture **excludes task content and evidence**, so `privacy.md`'s deletion guarantee survives a restore. |

**Two things the parameters do not settle, and both are load-bearing.** They are carried forward in
Open items rather than treated as closed:

1. **Three Tangem cards are only a 2-of-3 if they are three keys.** Tangem sells cards as a set that
   *shares one seed* by default — a set restored from one backup is one key wearing three plastic
   coats, and a 2-of-3 built on it has the security of a 1-of-1 while looking like a multisig on
   Basescan. "Initialised as distinct standalone wallets" is therefore not a preference, it is the
   whole property, and it must be **verified on-chain** (three unrelated addresses as Safe owners)
   rather than assumed from the setup flow.
2. **Who holds the three cards is still open, and D2's purpose depends on it.** D2 says "the founder
   holds one key, not all three". Three cards in one person's custody delivers *loss resistance* —
   a single lost or bricked card is survivable — but not *succession*, which is the problem this ADR
   exists to solve. An estate cannot reach a key it cannot find, and it certainly cannot reach two.

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

### D2 — Contract ownership moves to a 2-of-3 multisig before mainnet, and the owner is not the verdict signer

One HSM key currently owns the contracts *and* is the accepted verdict signer. `CC-090` proposed
separating them and was rated P2 on the reasoning that separation buys nothing against a *compromise*
while both roles sit on one key. Succession is a second, independent and stronger argument for the
same change, and it re-rates `CC-090` to P1.

- **Owner → 2-of-3 multisig.** The founder holds one key, not all three.
- **Verdict signer stays a single HSM key**, because it needs to sign automatically and holds no
  custody. Losing it fails safe: no verdicts → everything resolves to workers after the review window
  (`ADR-0001` D6).
- Naming the other two key-holders is the hard part, and it is a decision, not an engineering task —
  see open items.

**Accepted 2026-08-26 — the architecture is a 2-of-3 Safe over three hardware-isolated keys**,
implemented as Tangem cards initialised as **distinct standalone wallets**. Separation of the
contract owner from the automated HSM verdict signer is confirmed and is now a stated invariant
rather than an aspiration: `verify-contract-owner.mjs` and `verify-signer.mjs` already assert each
half, and together they assert the separation.

**The failure mode to design against is a multisig that is not one.** A Tangem set restored from a
single seed presents three cards and one key. The acceptance test is therefore on-chain and not
procedural: three Safe owners at three addresses with no shared derivation, checked before any value
moves. `CC-090` carries it.

Custody of the three cards remains open (see Open items). Until it is answered, this change buys key-
loss resistance and signer separation — not succession.

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

Still to choose: the **bound values**, in the same `MIN`/`MAX` shape as the review window. Open item.

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

## Open items

- ~~**Copyright holder: Aaron personally, or North Metro Tech.**~~ → **Aaron James Clifft
  personally**, accepted 2026-08-26 (D1). The commercial *terms* still want a lawyer; the AGPL grant
  does not.
- **Who holds the three multisig keys — still open, and it is the whole of D2's succession value.**
  The architecture is settled (2-of-3 Safe, three distinct Tangem wallets); custody is not. Three
  cards in one person's hands is loss resistance, not succession. Options unchanged: a second person,
  a separately-held mechanism, a legal/estate arrangement. **Do not treat D2 as delivering succession
  until this is answered** — that would be the most consequential mis-read available in this ADR.
- **Arbitration deadline bounds** — the D3 numbers, in the same shape as `MIN`/`MAX_REVIEW_WINDOW`.
  Needed before the `CC-034` bytecode is frozen, because D3 is now a bytecode commitment.
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
   tickets 2026-08-26. **Blocked on custody**, not on engineering.
5. **Arbitration deadline in the contract** (D3) — in the mainnet deploy, with tests. Scoped into
   `CC-034` 2026-08-26. **Blocked on the bound values.**
6. **Profile signing** (D9) — before the registry holds real workers.
7. **ENS record and the announcement channel** (D6), folded into `CC-044`'s rewrite.
8. **Protocol spec** (D7) — after `CC-092`, when the surface it describes exists.

Related: `CC-091`, `CC-090`, `CC-034`, `CC-039`, `CC-087`, `CC-044`, `CC-056`, `ADR-0001` (D6, D9,
A1.2), `ADR-0002` (D4, D5, D9), `ADR-0003` (D5), `docs/Key-Compromise-Recovery.md`,
`docs/funds_control_aml_gating.md`.
