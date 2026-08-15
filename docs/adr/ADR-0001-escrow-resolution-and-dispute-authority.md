---
id: ADR-0001
title: Escrow resolution, evidence commitments, and dispute authority
status: accepted
date: 2026-08-13
amended: 2026-08-13 - D4/D6/D9 revised, see Amendment 1
deciders: Aaron Clifft
supersedes: none
amends: CC-080 (clarifies "the paying agent controls release")
resolves: CC-081 Defect 2 (dispute authority), CC-075 (AWOL mechanism)
blocks: CC-036, CC-051, CC-072, CC-074, CC-077, CC-078, CC-079
area: architecture
epic: public-launch
---

# ADR-0001 — Escrow resolution, evidence commitments, and dispute authority

## Status

**Accepted**, 2026-08-13. Supersedes the "Fix — deliberately not specified" sections of `CC-081` Defect 2 and `CC-075`.

---

## Context

`CC-081` Defect 2 left the dispute design open, and `CC-075` left AWOL detection open. They are the same question — **who wins when a party stops participating** — and neither can be answered without also answering what a completed task actually is.

### The structural defect

`CarbonEscrow` has exactly one clock: task deadline → `expireTask` → refund agent. Silence therefore always resolves in the agent's favour. This produces an unhandled loss case that neither open issue names:

- **Worker AWOL** — expiry refunds the agent. No loss. Correctly triaged P2 in `CC-075`.
- **Agent AWOL** — the worker delivers, the agent never calls `completeTask`, the deadline passes, `expireTask` refunds the agent. **The worker has delivered and been paid nothing, automatically, with no bad actor required.**

Combined with Defect 2's app-layer inversion (`dispute_task` and `resolve_dispute` are both agent-only, `src/lib/mcp/server.ts:731`, `:873`), the worker currently has no path to payment that does not depend on the agent's continued goodwill. The escrow provides the worker nothing but a locked stake and the appearance of protection.

### The worked case that drove the design

> An agent posts: *"Go to the car yard and take photos showing the true condition of this vehicle before my human drives across town."* The worker submits AI-generated or unrelated stock images. The agent inspects the files and metadata, knows they are fake, and refuses to release.

The platform should not have to adjudicate this. It currently would have to, because the rejection lives inside the agent's private reasoning as an unfalsifiable assertion. Nothing recorded distinguishes it from the mirror case — a worker who submits forty genuine photos and is refused by an agent wanting free work.

The root cause is **unstated acceptance criteria**: the agent writes prose, the worker submits, and the agent decides after the fact whether it counted. That is grading against a rubric written after the answers arrived, which is Defect 2 again in a more sympathetic costume.

### Constraint

The platform holds no funds and manages no funds. This is non-negotiable and shapes every decision below. See `CC-051`.

---

## Decision

### D1 — Two clocks and a delivery signal

Add a worker-callable `submitWork`. Silence then resolves in favour of **whichever party last took a verifiable action**, so neither party can win by disappearing.

State machine:

```
None → Funded → Delivered → Completed
                    │            ↑
                    │            └── releaseAfterReview (review window elapsed)
                    ├──→ Disputed → Arbitrating → Resolved
                    │
  Funded ───────────┴──→ Expired (deadline passed, no submission → refund agent)
```

- `submitWork(taskId, evidenceHash, specVersionAck)` — caller must be `task.worker`, state `Funded`. Sets state `Delivered`, records `submittedAt`, opens the review window.
- Agent acts within the window → `completeTask` (unchanged, agent-only) or `disputeTask`.
- Review window elapses with no agent action → `releaseAfterReview(taskId)` → **pays the worker**. Called by the worker as a **pull-payment claim** — see Amendment 1.
- Worker never submits → `expireTask` at deadline → refunds agent. Unchanged.

### D2 — The requesting agent does not adjudicate its own dispute

`dispute_task` is corrected to permit **either party**, matching `CarbonEscrow.disputeTask`'s existing on-chain grant (`:141-153`). `resolve_dispute` is removed from agent authority.

This does **not** overturn `CC-080`. "The paying agent controls release" stands: `completeTask` remains agent-only and an agent may always pay early. The distinction now made explicit is **control over release ≠ authority over adjudication**. An agent may always choose to pay; it may not choose not to pay after delivery has been made and verified.

Rationale: the agent already holds release (`completeTask`) and already holds refusal (inaction). Granting `resolve_dispute` as well means it holds both outcomes, and `onlyOwner` degrades to the platform notarising one interested party's decision. It also makes `slash()` (Defect 5) permanently indefensible, and would require stripping both "escrow with dispute resolution" and "skin in the game" from `README.md` and `/learn`.

### D3 — Acceptance criteria are committed before work is accepted

`request_human_work` carries a machine-checkable acceptance spec alongside the prose description, shown to the worker **before** they accept. Authoring this spec is work the hiring agent is well-suited to and is core to the platform being agent-native.

Illustrative spec for the car-photo case:

```json
{
  "min_artefacts": 8,
  "exif_gps_within_m": { "lat": -37.8136, "lon": 144.9631, "radius_m": 100 },
  "captured_after": "task_funding_block_timestamp",
  "provenance": { "require_camera_model": true, "reject_c2pa_ai_generated": true },
  "phash_max_similarity_to": { "source": "listing_images", "threshold": 0.85 }
}
```

The fraudulent submission in the worked case fails on capture timestamp alone, before any state transition and before anyone exercises judgement. The task never leaves `Funded`.

### D4 — Commitment scheme: the chain holds hashes, the DB holds preimages

The chain does not store evidence. It stores proof that the evidence and the criteria are the ones the parties agreed to, written at the moment each becomes binding.

| Commitment | Written at | By | Binds |
| :---- | :---- | :---- | :---- |
| `specHash` | `createTask` | agent | acceptance criteria, frozen before the worker accepts |
| `evidenceHash` | `submitWork` | worker | the submission, frozen before review |
| `verdictHash` | claim (presented, not posted) | verdict signer | `{specHash, evidenceHash, checkerHash, result, per-check breakdown}` |

Struct additions to `CarbonEscrow.Task`:

```
bytes32 specHash;        // set in createTask
bytes32 evidenceHash;    // set in submitWork
uint64  submittedAt;     // starts the review window
bytes32 verdictHash;     // recorded at claim, from the presented signed verdict
bool    verdictPassed;   // the single bit releaseAfterReview consumes
```

Properties obtained: the worker can verify pre-acceptance that `specHash` matches what they were shown (no goalpost-moving); the agent cannot claim different evidence was submitted; and because `verdictHash` covers `checkerHash`, **any verdict is re-runnable and therefore falsifiable by anyone**.

This sharpens rather than weakens `CC-081` Defect 3. Money state stays authoritative on-chain with the DB as projection, exactly as `CLAUDE.md` requires. Content lives in the DB and is *verifiable against* the chain — a row whose hash does not match its commitment is provably corrupt and can be detected programmatically. Add `scripts/audit/verify-commitments.mjs` alongside `verify-escrow-solvency.mjs`.

### D5 — The checker is deterministic and contains no LLM

Re-runnability is the security property that makes the verdict falsifiable rather than discretionary. LLM inference is not reproducible across sampling seeds or model versions, so a verdict containing one cannot be re-run and the property is lost.

- **In the deterministic checker**: artefact counts, EXIF GPS radius, capture timestamp vs funding block, C2PA/provenance assertions, camera model presence, perceptual-hash comparison against supplied reference images. All thresholds pinned in `checkerHash`. Dependencies pinned. **No network calls** — a checker that fetches something mutable is not deterministic.
- **Not in the checker**: "do these eight photos genuinely show the vehicle's condition, or are they eight angles of one bumper." Irreducibly subjective. Routes to the D8 jury tier and never blocks a task from resolving.

The published checker bundle is content-addressed; `checkerHash` is its digest and doubles as `ruleVersion`.

### D6 — Liveness default: no verdict posted → release to worker

If work has been submitted and no verdict is posted before the review window closes, funds release to the worker.

This is deliberate and replaces an earlier draft position (refund agent) that was rejected because it hands the platform a griefing lever by inaction — the same authority problem inverted. Under D6 both parties are motivated to post a verdict (the worker when it passes, the agent when it fails) and **platform inaction cannot decide an outcome**.

### D7 — Reputation is not an input to adjudication

Reputation informs search ranking, auto-booking eligibility and hiring. It does not decide disputes. A dispute is precisely where reputation is being contested, so score-decides-disputes creates a feedback loop (win disputes → preserve score → win more disputes), is farmable with cheap early wins, and renders legitimate complaints against established workers structurally unwinnable.

This explicitly declines the "auto-resolve on reputation" half of earlier project discussion. The attestation and time halves are retained, in D4 and D1 respectively.

### D8 — Adjudication market and progressive slashing are v2

Deferred, and never a dependency of the happy path.

- **Scope**: the jury rules on good-faith fulfilment of the spec, *not* on re-running the deterministic check (which anyone can verify mechanically).
- **Value floor**: a $5 task with a 5% pool is $0.25 split three ways. The README's microtask premise sits mostly below the floor, so the jury is available above a threshold by escalation, never compulsory. Timeout resolution carries the volume.
- **Mechanism**: stake-weighted random selection excluding task parties and shared funding sources; commit-reveal voting; majority takes a fee from escrow, minority forfeits a slice of stake.
- **Slashing** (`CC-081` Defect 5): **progressive** — 25%, then 50% of remainder, then the balance. A flat "lose everything at 3" is identical to "lose everything at 1" for anyone who can abandon a wallet and re-register, since the stake is their entire cost of doing so.
- **Strikes**: 90-day rolling window with decay. Require established fault — an uncorrected check failure or a jury ruling — never a bare failure. One resubmission is permitted inside the review window before a strike lands.
- **Both sides stake and both sides accrue strikes.** The mirror fraudster is an agent that disputes submissions passing every published check, taking free work or a free option on the worker's time.

This gives `slash()` its first defensible trigger: fault established by a published re-runnable rule or by a staked jury, never by an interested party.

### D9 — Custody and authority stated separately

- **Custody — settled by bytecode, not policy.** `resolveDispute`'s destination is `releaseToWorker ? task.worker : task.agent`, both fixed on-chain at funding (`CarbonEscrow.sol:159-175`). No arbitrary destination is reachable by anyone, owner included. This holds against a compromised signer or an order against the platform.
- **Authority — bounded, not eliminated, in v1.** The platform posts the verdict. Automating it scales the exercise of that authority; it does not remove it. What v1 achieves is that the authority is **falsifiable** — published rules, published inputs, re-runnable result — rather than discretionary.
- **v2 removes the privilege**: verdicts become permissionless against a bond, with a challenge window escalating to the D8 jury. The platform becomes the *fastest* verdict poster rather than the *only* one, and its discretion is bounded by anyone's ability to do its job.

### Rejected alternatives

| Rejected | Why |
| :---- | :---- |
| Agent resolves its own dispute | Unilateral clawback with a state transition; blocks `slash()`; forces removal of escrow and staking claims from public copy |
| Platform adjudicates as primary path | Discretionary authority over funds; does not scale; contradicts "no platform middleman" |
| Reputation decides disputes | Feedback loop, farmable, structurally unwinnable against established parties (D7) |
| 50/50 split as unresolved-dispute fallback | Pays a fraudster 50% merely for filing a dispute — a payout for escalating |
| No verdict → refund agent | Gives the platform a griefing lever by inaction (D6) |
| LLM in the deterministic checker | Destroys re-runnability, the property the whole design rests on (D5) |
| Jury as primary resolution path | Economics do not close below the value floor; imposes latency and cost on every microtask |
| Platform submits verdict transactions | Marginal gas cost scales linearly with volume; puts platform liveness in every settlement path (Amendment 1) |

---

## Amendment 1 — 2026-08-13 — verdicts are signed off-chain; settlement is pull-payment

Raised while scoping `CC-040` (production monitoring), which surfaced that the design as first written put the platform in the transaction path of every settlement. That is incompatible with the project's near-zero-cost, self-sustaining goal and creates monitoring obligations that should not exist.

### A1.1 — `postVerdict` becomes an EIP-712 signed verdict, not a transaction

The verdict is signed off-chain by the verdict signer and handed to the parties. Whoever claims presents the signature; the contract recovers the signer and verifies it against an accepted-signer set. `postVerdict` ceases to exist as a state-changing function.

```
Verdict = {
  taskId, specHash, evidenceHash, checkerHash,
  passed, breakdownHash, expiry, nonce
}
```

Consequences:

- **The platform makes no transaction at all.** No gas, no nonce management, no signer liveness in the settlement path, no failed-transaction alerting, no deployer balance dependency.
- **`CC-040`'s "KMS signing failures" scope shrinks** to "the signer can produce a signature", which is a health check rather than an on-chain monitor.
- **v2 becomes a set change, not a rewrite.** `ADR-0001` D9's permissionless verdicts reduce to accepting signatures from any bonded signer, rather than opening a privileged function.
- `expiry` and `nonce` are mandatory — an unbounded signed verdict is a replayable authorisation.

### A1.2 — `releaseAfterReview` is pull-payment, claimed by the worker

Originally "callable by anyone", which meant nobody was responsible for calling it. The worker is the motivated party, pays their own gas (fractions of a cent on Base), and claims their own payment.

This also adopts the standard pull-payment safety posture — no push loops, no reentrancy surface on a platform-initiated disbursement, no funds stranded because a third party did not act.

`expireTask` follows the same principle: the agent claims their own refund.

### A1.3 — Liveness restated

D6 stands unchanged in substance: **work submitted + no valid failing verdict presented before the window closes → the worker can claim.** The platform's inaction still cannot decide an outcome, and now the platform has no action to take in the happy path at all.

The residual failure mode moves from "platform fails to transact" to "platform fails to *sign*", which is what `ADR-0003` monitors.

---

## Consequences

### Contract change and redeploy

D1 and D4 change `CarbonEscrow`. **Redeploy on Base Sepolia now** — the escrow holds 0 USDC with `totalLocked` 0 (`verify-escrow-solvency.mjs`, 2026-08-11), so this is free today and will not be later.

**Sequencing is load-bearing:** this ADR lands *before* `CC-081` Defect 1's fix, so the app layer is rewritten once against the final ABI rather than twice. Take the `CC-036` attestation slot in the same redeploy — accept an optional `bytes32 attestationUid` on `submitWork`, unused until EAS lands.

### Zero PII conflict — must be resolved

`README.md` states *"Zero PII — no personal data stored, ever."* Photos of a vehicle in a dealer's yard contain number plates, faces, and a GPS trace of a worker's real movements. Storing task evidence and that constraint cannot both be true.

**Resolution**: the platform stores hashes only. Evidence goes to a bucket the agent nominates; the checker receives a time-limited URL and the platform never holds the bytes. This preserves the constraint and removes the platform from the data path as well as the money path.

### Category applicability

Deterministic checkability varies sharply by service category. Photo tasks check well; address verification checks moderately; "review this PR" barely checks at all. Categories with no meaningful automated check will generate the adjudication load, and are candidates for value caps or exclusion from auto-booking. This needs encoding in `/services` and feeds back into `CC-075`.

### CC-075 resolves as a consequence, not as separate design

Once `submitWork` exists, "worker did not deliver" is distinguishable from "agent did not accept" — the signal `CC-075` was missing.

- **Trigger**: N consecutive `TaskExpired` events with zero `WorkSubmitted` (start at N=3).
- **Where**: checked inline at auto-booking time, not on a cron. A scheduled job maintaining a flag that is only read at booking is pure overhead.
- **Action**: set `accepts_auto_booking` false, notify, worker self-re-enables from the dashboard.
- **Explicitly not** a slash and not a reputation penalty. An expiry refunded the agent; nobody lost anything, and the legitimate-leave false positive costs the worker one toggle.

`CC-075` remains downstream of `CC-074` and now also of this ADR.

### Residual risks

- **EXIF is forgeable.** A determined fraudster can set GPS and timestamps. The check is a cost floor, not proof — it defeats the lazy attack and makes a frivolous dispute visibly frivolous. Real capture provenance is C2PA, which is device-dependent and not yet universal. The spec schema must treat a provenance assertion as one more field, not a rewrite.
- **The platform is the oracle in v1.** Mitigated to falsifiable, not eliminated. State this plainly in `docs/Security-Trust-Disclosure.md` rather than letting the position read as fully trust-minimised.
- **Regulatory read on D9.** Directing release between two fixed parties may still constitute control under some framings even with no third-party destination reachable. `CC-051` needs a lawyer's review, not an engineering read.

---

## Open items

**Closed 2026-08-15 while implementing `CC-082`.** Both were load-bearing on the bytecode, so
they were settled before the contract was written rather than after it was deployed.

- ~~Review window duration, and whether it is fixed or agent-set within bounds.~~ →
  **Agent-set at `createTask`, bounded by the contract.** `MIN_REVIEW_WINDOW` 12h,
  `MAX_REVIEW_WINDOW` 14d. Both bounds carry weight: the lower stops a worker claiming before
  the agent can look at anything, the upper stops an agent stalling a delivered worker
  indefinitely. A fixed constant was rejected because tuning it would cost a redeploy and a
  $5 photo task and a multi-day job do not want the same number; an owner-settable default was
  rejected because it lets the platform change the timing of live tasks, which is more
  authority than D9 wants.
- **What a valid failing verdict does** — under-specified by A1.3, which said only that it
  blocks the worker's claim. → **It moves the task to `Disputed`.** It does not refund the
  agent. Refunding would hand the verdict signer unilateral power to take money off a worker
  who has already delivered, with no recourse — exactly the authority D9 exists to bound.
  Returning to `Funded` for a resubmission was rejected as D8 work, which is v2.
- **`disputeTask` requires a signed failing verdict; there is no bare-assertion dispute.**
  This follows from D2 and D6 together rather than from either alone, and it is the single
  most consequential reading in the implementation. If a bare call could block the worker's
  claim, the agent would still hold both outcomes — release via `completeTask`, refusal via
  disputing — and the escrow would protect nobody. Requiring a signature is what makes a
  refusal re-runnable, and therefore falsifiable.

  **The sharp edge, stated plainly:** if the platform will not sign a failing verdict, the
  agent has no on-chain recourse and the worker is paid. That is D6's liveness default working
  as designed, but it also means a task with no machine-checkable spec (`specHash == 0`)
  *always* resolves to the worker. The "category applicability" consequence below now has a
  concrete mechanism behind it, and it is the strongest argument yet for value caps on
  categories that do not check.

Still open:

- Value floor for jury escalation.
- Spec schema versioning and its own migration path.
- Whether `specHash` covers the prose description as well as the machine-checkable criteria.
- `CC-070` currently breaks `getTaskResolvedOutcome`, which the event-reading half of Defect 3's fix depends on.
- **Categories with no meaningful automated check now have a determinate outcome — the worker
  wins.** Decide whether that is acceptable, or whether those categories need caps, exclusion
  from auto-booking, or a different resolution path. Feeds `/services` and `CC-075`.

---

## Handover — implementation order

1. **Contract** — add `submitWork`, `releaseAfterReview` (pull-payment), and EIP-712 verdict verification with an accepted-signer set, per Amendment 1 — **not** a `postVerdict` function; add the five struct fields plus the `CC-036` attestation slot; add `Delivered` and `Arbitrating` states; correct `dispute_task` authority to either party. Redeploy to Base Sepolia. Call `transferOwnership()` to the HSM key while redeploying (`CC-059`).
2. **Checker** — deterministic, no network, pinned dependencies, content-addressed bundle; `checkerHash` published.
3. **Spec schema** — versioned; `request_human_work` accepts and commits it; worker-facing display before acceptance.
4. **CC-081 Defect 1** — agent calls `createTask` from its own wallet; `/api/fund-task` ceases to be an x402 payment recipient. Against the *final* ABI.
5. **CC-081 Defect 4** — authenticate `request_human_work`, bind `from_agent_wallet` to the caller, validate `to_human_wallet` against `humans` (lowercased both sides).
6. **CC-081 Defect 3** — gate `active` on reading `Funded`; gate terminal statuses on confirmed receipts, not submitted hashes.
7. **Audit scripts** — `verify-commitments.mjs`; wire both audit scripts into CI.
8. **Copy** — `README.md` and `/learn` updated to match: the staking claim, the dispute description, and the Zero PII resolution.
9. **Deferred to v2** — permissionless verdicts, bonds, challenge window, jury, progressive slashing.

Related: `CC-081`, `CC-080`, `CC-075`, `CC-074`, `CC-051`, `CC-059`, `CC-070`, `CC-036`, `CC-072`, `CC-020`.
