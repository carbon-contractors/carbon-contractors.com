# Design review — 2026-08-19 — documentation alignment, DR, and the agentic protocol

Scope: **design intent and documentation alignment, not a code audit.** Aaron's framing: the project
is roughly 45% through development; the goal is that the guiding documents are aligned, that a
regulator reading them is satisfied, that the platform is as resilient as a near-zero budget allows,
and that the project can outlive its founder for as long as anyone finds it useful.

Read for this review: all five ADRs including amendments, `docs/adr/README.md`, the backlog index,
`CC-014`/`028`/`039`/`044`/`045`/`051`/`056`/`058`/`076`/`085`/`089`/`091`/`092`/`098`/`099`,
`funds_control_aml_gating.md`, `Security-Trust-Disclosure.md`, `src/legal/terms.md`,
`src/legal/privacy.md`, the mainnet migration checklist, and the infrastructure DR plan. Not read:
the remaining ~84 tickets, `Lessons-Learned.md` in full.

Findings are sorted into the three buckets defined in `Capability-Surface-Matrix.md`. **The sort is
the point.** Everything in bucket 3 is the plan working, recorded here only so it is not re-reported
as a defect by the next reviewer.

---

## Bucket 1 — published and wrong

A public claim that contradicts reality today. `ADR-0004`'s "copy describes the target state" licence
does **not** cover these: they are factual state claims or operative legal terms, not forward-looking
marketing.

| # | Where | The problem |
| :-- | :-- | :-- |
| 1.1 | `src/legal/terms.md` | Describes v1 mechanics throughout: "disputes are arbitrated by the platform… based on our judgment of the evidence", "either party can raise a dispute while a task is funded", "anyone can trigger a refund to the agent". Under v2 a dispute requires a **signed failing verdict**, `expireTask` is the **agent's own** pull-payment, and adjudication is rule-based and re-runnable. These are the operative terms a regulator or a consumer-law complaint reads first. → realigned draft in this change set |
| 1.2 | `docs/Security-Trust-Disclosure.md` | Points readers at the **v1** escrow (`0xb9bF8dAC…`) and invites them to `read owner()`. v2 is `0xe80d0368…` (`CC-082`). The verification the document invites returns an answer about an abandoned contract. → realigned draft in this change set |
| 1.3 | `docs/Security-Trust-Disclosure.md` | Says "the only way to move funds is through the logic defined in the smart contracts, triggered by the audited platform application". False since Amendment 1: settlement is pull-payment and **the platform makes no transaction at all**. Also missing the disclosure `ADR-0001`'s residual-risks section explicitly requires here — *the platform is the oracle in v1, mitigated to falsifiable, not eliminated*. |
| 1.4 | `README.md:191` | "**Zero PII** — no personal data stored, ever." Superseded by `ADR-0002` D2. Already ticketed as `CC-027`; noted here because it is bucket 1, not bucket 3, and because `ADR-0002` handover item 9 ties the fix to dropping `waitlist` (`CC-089`) in the same change. |
| 1.5 | `README.md:148-149` | Still states the raw key owns `CarbonEscrow` and the HSM key was "funded, never given ownership". Corrected on-chain 2026-08-08 and again at the v2 redeploy. The README is also the DR plan's nominated human-readable failover anchor — it should not be the document with stale state claims. |
| 1.6 | `src/legal/privacy.md` | Publishes "you can ask us to delete anything we hold on you at any time" as a live commitment, while Supabase Pro PITR retains deleted rows for the backup window. `ADR-0002` D9 names this trap; nothing has closed it. This is bucket 1 because the claim is already published, and bucket 2 because the fix is a storage-architecture decision. |

**Cheap structural fix for the whole bucket:** addresses, deploy block, owner and network are facts
the audit scripts already print. Generate those lines rather than typing them, and add a
`ADR-0004` carve-out saying so.

---

## Bucket 2 — one-way doors

Expensive or impossible to reverse. Worth deciding early even where the work is distant.

**2.1 — There is no `LICENSE` file.** `README.md:196` says "MIT"; no licence file exists and
`package.json` carries `"private": true`. A public repo with a bare README declaration is a weak
grant at best — legally, nobody can confidently fork, re-host or operate this. Every other
continuity mechanism in the project is downstream of that one file. Addressed by the `LICENSE` /
`COMMERCIAL.md` drafts and `ADR-0006` D1, including the question of whether `contracts/` should stay
MIT (recommended) while the platform moves to AGPL.

**2.2 — Succession, and the one genuine stranding case.** `CC-091` has this right and is the
strongest reasoning in the repo: pull-payment gave bus-factor resistance for free, except for tasks
in `Disputed`/`Arbitrating`, where `resolveDispute` is `onlyOwner` with no timeout. That is
QuadrigaCX scoped to disputed tasks. Fixing it needs a **contract change**, so it must land before
the mainnet deploy or not at all for v1. → `ADR-0006` D2/D3.

**2.3 — The `resolveDispute` override has no owner and no decision.** `funds_control_aml_gating.md`
Track C names it and says no ticket exists. It is the gap between "structurally cannot adjudicate
unilaterally" being aspirational and being true. → `ADR-0006` D4.

**2.4 — Falsifiability has an undeclared shelf life.** `ADR-0001` D5/D9 rest on verdicts being
re-runnable indefinitely — A2.2 argues explicitly that the checker must evaluate six-month-old
specs. `ADR-0002` D4 deletes the spec and evidence preimages days after settlement. **You cannot
re-run a verdict whose preimages are gone.** Two accepted ADRs contradict each other on the property
the whole trust model rests on. Options: accept and state it (falsifiable only inside the dispute
window, which A2.4 half-says already); push re-run capability onto the parties who hold the
preimages; or retain criteria-only preimages, since the PII lives in the evidence, not usually in the
criteria. Needs an `ADR-0001` amendment either way.

**Second driver, added 2026-08-19:** `ADR-0007` A1.2 adopts a retroactive audit of timed-out
disputes, which slashes bonded stake where fraud is established. That audit reads the same preimages.
Retention is therefore a **joint parameter** — `max(dispute window, retroactive audit window)` — and
two independent mechanisms now depend on preimages outliving settlement. This has stopped being a
documentation tidy-up.

**2.5 — Backups versus deletion.** `ADR-0002` D9's cleanest answer is *never write task content to a
backed-up table*; the DR plan wants tested Supabase restores; `privacy.md` publishes an unconditional
deletion promise. A restore that resurrects deleted task content turns a DR action into a privacy
breach. Also: `verify-retention` as specified checks live tables only, so it would pass throughout.
→ `ADR-0002` amendment + `ADR-0006` D8 + a scope line on `CC-087`.

**2.6 — `humans` has no on-chain commitment.** `ADR-0001` D4 gives task and money state
tamper-evidence; the whitepages — handle, categories, rate, availability — has none. Reputation
survives a rebuild because `ADR-0002` D5 derives it from events; the registry that makes the
marketplace usable does not. A replacement backend could rewrite rates or silently drop workers and
pass every monitor. This is the hole in the DR plan's claim that a replacement backend needs no blind
trust. Cheapest fix that does not touch the contract: **workers sign their own profile record** and
the signature is stored alongside it. Decide before the registry has real workers in it.

**2.7 — AUSTRAC and sanctions before `CC-039`, not during.** `CC-098` and `CC-099` already say this
and are correctly rated P1. Recorded here only because the mainnet smoke test is the moment the
"nothing has run yet" defence expires.

**2.8 — No re-host manifest.** The v2 address, `ESCROW_DEPLOY_BLOCK`, USDC address, accepted
verdict-signer set, `checkerHash` and canary digest are scattered across `.env.example`, `CLAUDE.md`
hazard notes and ticket bodies. One committed `chain-constants.json` per network serves DR,
third-party verification and `CC-044` at once, and retires a recurring class of stale-integer hazard.

**2.9 — The DR plan is not in the repo.** It exists only as a project doc, which makes the document
describing how a stranger re-hosts from the public repo unreachable from the public repo. Same shape
as the failure its own §4 warns about. → `docs/BCP-DR.md`, `ADR-0006` D7.

---

## Bucket 3 — not built yet

The plan working. Listed so the next review reports them as status, not as faults.

- **Settlement has no MCP surface, and no app surface either.** `submitWork`, verdict signing, claim
  and verdict-carrying dispute exist in the contract and in `scripts/admin/verify-escrow-lifecycle.ts`
  and nowhere in `src/`. That is `CC-092`, correctly sequenced behind `CC-084`/`CC-083`, and it is a
  **deliberate** ordering — agents should not be able to submit work until the layers beneath it are
  proven. `CC-044` should be rewritten against the v2 lifecycle and re-sequenced after `CC-092`; its
  current tool list is inherited from NOR-300 and its own triage note already says so.
- **The jury tier is one paragraph.** `ADR-0001` D8 plus Track D. → drafted as `ADR-0007`, status
  proposed, so the design exists before it is needed rather than being invented under pressure.
- **`verify-commitments`, `verify-retention`, `verify-checker`, `verify-verdict-rate`** are deferred
  behind `CC-083`/`CC-084` per `CC-085`. Note for whoever builds `verify-commitments`: it needs a
  deliberate-corruption negative test. `Lessons-Learned.md` §24 is a script that printed PASS for
  months while checking the wrong property.
- **ENS / machine-readable failover pointer.** Nothing exists. Cheap, and it matters more for agents
  than for humans — an agent holding a hard-coded URL has a bookmark problem. → `ADR-0006` D6.
- **Protocol reimplementation spec.** The ADRs record decisions *for the operator*; nothing tells a
  third party how to run an equivalent server. → `ADR-0006` D7.

---

## What this review recommends, in order

1. `LICENSE` and `COMMERCIAL.md` (bucket 2.1) — an hour, unblocks everything about perpetuity.
2. `terms.md` and `Security-Trust-Disclosure.md` (bucket 1.1–1.3) — wrong *now*, on a public site.
3. `ADR-0006` accepted or rejected (bucket 2.2–2.3, 2.5, 2.8–2.9) — its contract-level decisions must
   precede `CC-034`.
4. `ADR-0001` amendment on 2.4, `ADR-0002` amendment on 2.5, `ADR-0004` carve-out on 1.1–1.5.
5. `ADR-0007` as `proposed` — no build work implied.
6. Bucket 3 stays on the board where it already is.

Related: `docs/Capability-Surface-Matrix.md`, `docs/adr/ADR-0006-*`, `docs/adr/ADR-0007-*`,
`CC-091`, `CC-092`, `CC-098`, `CC-099`, `funds_control_aml_gating.md`.
