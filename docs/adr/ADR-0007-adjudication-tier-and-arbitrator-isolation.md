---
id: ADR-0007
title: The adjudication tier — value-weighted review, and what an arbitrator may see
status: proposed
date: 2026-08-19
deciders: Aaron Clifft
depends-on: ADR-0001 (D5 checker, D7 reputation, D8 jury sketch, D9 authority), ADR-0002 (D1 pseudonymity, D3 data path, D7 notices), ADR-0006 (D3 arbitration clock)
resolves: funds_control_aml_gating.md Track D
area: architecture
epic: v2
---

# ADR-0007 — The adjudication tier

## Status

**Proposed**, 2026-08-19. Nothing here is scheduled. The purpose of writing it now is that
`funds_control_aml_gating.md` calls the jury tier *"the single largest true unknown in the whole
adjudication stack"*, and an unknown with a design is smaller than one without.

---

## Context

`ADR-0001` D8 is one paragraph: stake-weighted random juror selection, commit-reveal voting, majority
takes a fee, minority forfeits stake, available above a value floor. That paragraph has carried the
whole subjective-dispute story since August 2026 and it does not survive contact with three things
the rest of the architecture already decided.

1. **What the jury is for.** D5 draws the line: mechanical checks (artefact counts, EXIF GPS radius,
   capture timestamp, provenance, perceptual hash) are re-runnable by anyone, so they need no jury.
   What is left is *"do these eight photos genuinely show the vehicle's condition, or are they eight
   angles of one bumper"* — irreducibly subjective, and **only answerable by looking at the
   evidence.**
2. **The evidence is the identity.** D3's own example spec pins GPS within 100 m and capture time
   against the funding block. Show a juror the evidence and you have shown them where a pseudonymous
   worker stood, at a known time, correlatable by wallet against a permanent public ledger. **Hashing
   isolates a juror from tampering, not from identity.** Any design that claims "commitments keep
   arbitrators blind" is claiming something the commitments do not do.
3. **`ADR-0002` D3 keeps the platform out of the data path.** A jury that views evidence either puts
   the platform back in that path, or makes the hiring agent disclose third parties' photographs to
   randomly selected strangers. The second is worse: it is an unplanned disclosure of other people's
   personal information, which is exactly the statutory-tort and GDPR exposure D3 and D4 exist to
   remove. This is the largest unaddressed consequence of D8 and it is a privacy-law problem before
   it is a mechanism-design one.

Aaron's framing for this review added a fourth requirement — **effort should scale with the money at
stake** — which is right, and is the axis the rest of this ADR is built on.

---

## Decision

### D1 — Escalation tiers, weighted by escrow value

One resolution path does not fit a $5 photo task and a $500 multi-day job. Three tiers, selected by
escrow value at funding, so both parties know the resolution path before anyone commits:

| Tier | Value | Resolution |
| :-- | :-- | :-- |
| **T0 — mechanical only** | below the jury floor | deterministic checker plus the clocks. No human review, ever. Timeout resolution carries the volume, exactly as `ADR-0001` D8 says. |
| **T1 — single reviewer** | mid | one staked reviewer, drawn from the pool, rules on the derived artefact (D3). Cheap enough to close the economics gap the jury floor leaves open. |
| **T2 — panel** | high | odd-numbered panel, commit-reveal, stake-weighted selection excluding the parties. `ADR-0001` D8's mechanism, reserved for the value that pays for it. |

**The floor is set by the fee the tier can pay, not by taste.** A 5% pool on a $5 task is $0.25 split
three ways, which buys nothing. Whatever number is chosen, the tier boundaries are published and
committed with the task, because a party that does not know the resolution path has not agreed to it.

### D2 — Reviewers see a derived artefact, never the raw evidence

The core privacy decision, and the one that makes the tier compatible with `ADR-0002`.

The reviewable package contains: the **acceptance criteria** in human-readable form, the **per-check
breakdown** from the deterministic checker, and a **derived rendering** of the evidence — EXIF
stripped, downscaled, faces and plates obscured, location generalised to whatever precision the
criterion actually needs.

- If the criterion is "within 100 m of this point", the reviewer needs "pass/fail", not coordinates.
- If the criterion is "eight distinct artefacts of the vehicle", the reviewer needs eight images good
  enough to judge distinctness, not the originals.
- **If a category's subjective question cannot be answered from a derived artefact, that category
  does not get a jury tier at all** (D4).

Derivation happens **at capture or in the checker's scratch pass**, never as a new durable platform
copy — `ADR-0002` D3 stands. Producing derived artefacts is a checker responsibility, and the derived
artefact is itself committed (`derivedHash`) so a reviewer's view is as tamper-evident as the
original.

### D3 — Isolation is one-directional, and that is stated plainly

The reviewer is not shown the parties' wallets, handles, reputation or history. But **an on-chain
dispute is public**, so a determined reviewer can correlate a case to a task and thence to a wallet.

This ADR therefore does **not** claim arbitrator anonymity. It claims:

- reviewers are **not told** who the parties are;
- reviewers see **as little personal information as the question allows** (D2);
- reviewers are **staked and accountable**, and accept confidentiality obligations as a condition of
  the pool.

Overclaiming here would be the same failure as "zero PII" (`ADR-0002`) and "trust removed entirely"
(`Security-Trust-Disclosure.md`) — a claim the architecture cannot keep.

### D4 — Categories that cannot be reviewed safely are excluded, not accommodated

`ADR-0001` already notes that deterministic checkability varies sharply by category, and `ADR-0002`
D7 notes the categories with the weakest checks are largely the ones with the highest PII risk. The
same categories fail both tests, so they get the same answer: **no jury tier, capped value, excluded
from auto-booking.** Encoded in `/services` alongside the existing checkability tiering.

This is also the answer to `ADR-0001`'s still-open item — *categories with no meaningful automated
check now resolve to the worker; is that acceptable?* Under this ADR it is acceptable **because the
value is capped**, not because the outcome is right.

### D5 — Arbitration has a clock, and juror silence pays the worker

Adopts `ADR-0006` D3 rather than inventing a second mechanism. A panel that does not rule is
indistinguishable from a platform that does not act, and `ADR-0001` D6 already decided what happens
then: the worker can claim.

Two consequences worth stating:

- **The tier must fit inside the contract's clocks.** The review window is 12h–14d
  (`MIN`/`MAX_REVIEW_WINDOW`), and `ADR-0001` A2.4 makes it a security parameter, not only worker UX.
  A T2 panel that needs a week only exists for tasks whose agent set a long window.
- **Entering arbitration must stop being an owner-only act** for the tier to be meaningfully
  decentralised. `beginArbitration` is `onlyOwner` today, which puts platform liveness back into
  dispute resolution — the thing Amendment 1 removed from settlement. Opening it is a v2 contract
  change and is listed as an open item, not decided here.

### D6 — Sybil resistance is economic, because identity is off the table

`ADR-0002` D1 stands: no identity verification. So "exclude jurors sharing a funding source" is a
heuristic that one person with several wallets and a little patience defeats.

Therefore **juror stake must exceed the profit available from colluding on the dispute being
decided**, which is a hard cap: *a panel may only decide disputes worth less than the stake backing
it.* That is the real value ceiling on this design, and it is more binding than the floor. It also
collides with the existing evidence that workers resist even a 20 USDC stake (`CC-011`), so the pool
will not bootstrap from the worker base alone.

### D7 — Consent is given at acceptance, not discovered at dispute

The worker learns, before accepting, that a derived rendering of their evidence may be shown to
staked third parties if the task is disputed. Shown with the acceptance criteria (`ADR-0005`'s offer
surface, `ADR-0002` D7's notice), not buried in terms. The hiring agent gives the matching
undertaking at `request_human_work`.

A worker who does not want that can decline the task. A worker who discovers it during a dispute has
been treated the way this whole architecture exists to avoid.

---

## Rejected alternatives

| Rejected | Why |
| :-- | :-- |
| Commitment hashing isolates arbitrators from identity | It does not. It isolates them from tampering. The subjective question requires seeing content, and the content carries location, time and faces |
| Jurors see raw evidence | Discloses third parties' personal information to strangers; re-creates the exposure `ADR-0002` D3/D4 exist to remove |
| Jury as the primary dispute path | `ADR-0001` D8 already rejected it — economics do not close below the floor, and it taxes every microtask with latency |
| Reputation-weighted juror voting | `ADR-0001` D7's feedback loop, one layer removed but the same defect |
| An LLM as reviewer | `ADR-0001` D5 — not reproducible, so not falsifiable. The whole design rests on re-runnability |
| Platform stores derived artefacts durably to make review easier | Re-creates the data estate; derivation is a scratch operation with a hash, not a library |
| No arbitration clock, "a panel will get to it" | `ADR-0006` D3 — this is the stranding case in a different costume |
| Open juror registration with no stake | Free sybils decide money; the only cost of a bad ruling would be a discarded wallet |

---

## Amendment 1 — 2026-08-19 — cold start, finality, and rubber-stamping

Three refinements brought by Aaron the same day this ADR was drafted (developed with Gemini).
All three are adopted; two carry a correction that matters more than the refinement itself.

### A1.1 — D8: a vetted bootstrap pool carries T1/T2 until the pool is organic, and it has an exit condition

A juror pool cannot bootstrap from a marketplace with no users. A curated pool of trusted reviewers,
with platform-operated fallback capacity, guarantees coverage until volume attracts organic
participants. Adopted — it is the only honest answer to the cold-start problem this ADR's own open
items raised.

**Two conditions, without which this quietly becomes permanent:**

- **Name it for what it is.** A pool the platform curates, and especially one the platform staffs, is
  *the platform adjudicating with extra steps*. It belongs in `Security-Trust-Disclosure.md` beside
  the oracle disclosure, not described as decentralised arbitration.
- **Define "organic" in advance, and publish the measure.** For example: N independent stakers, no
  single entity selected for more than X% of cases over a rolling window, sustained for a period.
  A transitional mechanism with no exit test is a permanent mechanism with good intentions.

**Vetting must not become identity verification.** `ADR-0002` D1 stands. Vetting is by stake, track
record, and a published undertaking — not by name or document.

### A1.2 — D9: a payout is final; fraud is answered on the bonded stake, never by reversing settlement

If a worker games the clock with fraudulent evidence and is paid by timeout, the answer is **not** to
freeze or reverse the payout. On-chain finality is the guarantee the whole product rests on; a payout
that can be undone is not a payout.

- **Payout finalises** at the timeout, per `ADR-0006` D3.
- **The timed-out case enters a retroactive audit queue.** Established fraud slashes the worker's
  bonded stake — progressively, per `ADR-0001` D8 — and penalises reputation.
- **The audit is held to the same standard as everything else:** fault established by a published
  re-runnable rule or a staked panel, never by an interested party and never by platform assertion.
  An audit exempt from that standard is discretion arriving late.

The bytecode already agrees with the first bullet — there is no owner-callable refund and no path
back from a terminal state (`ADR-0001` A2.3). So this decision adds no capability. Its value is that
it **closes "couldn't we just claw it back" permanently**, the way A2.3 closed "couldn't we just
refund it".

**The correction, and it is load-bearing: the audit window cannot exceed the retention window.**
`ADR-0002` D4 deletes the acceptance-spec and evidence preimages at terminal state plus the dispute
window. A retroactive audit conducted after deletion has nothing to audit. Therefore:

> **retention window = max(dispute window, retroactive audit window)**, and it becomes a single joint
> parameter owned by both ADRs rather than two numbers set independently.

This is the **second** independent reason `ADR-0001` and `ADR-0002` must be reconciled on how long a
verdict stays falsifiable — the first being the D5 re-runnability contradiction recorded in
`docs/design-review-2026-08-19.md` §2.4. Two separate mechanisms now depend on preimages outliving
settlement. That is no longer a documentation tidy-up.

### A1.3 — D10: bonded stake sets the value ceiling a worker may accept

The economic defence against clock-gaming is **required stake > task escrow**: farming payouts by
running out the clock then loses money. Adopted, and its real consequence stated as a product rule:

> **The maximum task value a worker may accept is a function of their bonded stake.**

It is a credit limit, and it should be described as one. This reframes `CC-011`, where a new worker
balked at a 20 USDC stake demand: under this rule 20 USDC is not a fee for the privilege of
registering, it is the ceiling on the work they may take on, and it rises when they want to take on
more. That is a much better story and it should be the copy.

It also caps this tier from the other end: D6 already binds a panel to disputes worth less than the
stake backing it. **Both ceilings are stake-derived, and both are more binding than the value floor.**

Symmetry, per `ADR-0001` D8's "both sides stake": an agent filing disputes should face the same
arithmetic. Whether agent-side staking is required at v1 is an open item.

### A1.4 — D11: rubber-stamping is answered by pay-with-the-majority, and jurors may use any tools they like

The failure mode at scale is not absence — a $0.50–5.00 bounty for a few minutes is an attractive
yield and will attract both humans and automated reviewers. It is **speed-clicking to farm fees**.

- **Schelling-point payment:** a juror is paid only if their vote is with the majority, and risks
  their stake if it is not. Requires the commit-reveal already specified in `ADR-0001` D8 — without
  it, voters copy the first revealed vote and the incentive inverts.
- **Limit one:** with a bootstrap pool (A1.1) the "majority" may be one entity, so the economic
  defence does not function until the exit condition is met. Until then rubber-stamping is controlled
  by **curation, not economics**, and that should be admitted rather than assumed away.
- **Limit two:** escalate only cases where the mechanical checks *passed* and fulfilment is
  nonetheless contested. Otherwise jurors converge on echoing the checker breakdown — a Schelling
  point that is cheap to hit and adds nothing over the check that was already re-runnable.
- **Jurors may use LLMs and automated tooling.** `ADR-0001` D5 bans LLM inference from the
  *deterministic checker*, whose entire property is re-runnability. The jury layer never claimed that
  property. A juror's accountability is economic — their stake against the majority — so how they
  reach a vote is their business, and an automated reviewer that is wrong loses money like anyone
  else.
- **Fee arithmetic, stated so the tiers are not set by wishful thinking:** a $0.50–5.00 bounty at a 5%
  pool implies a $10–100 escrow. That is the implied T2 minimum and it sits above the microtask
  median. **T1, the single reviewer, is the tier that will actually run.** Build it first.

## Consequences

- **A `derivedHash` commitment joins the D4 scheme**, which is a contract change if it must be
  on-chain, and a database-plus-monitor change if it need not be. Decide before v2, not during.
- **The checker gains a redaction responsibility** (`CC-083` scope note), which is new and is not
  trivially deterministic — blurring must itself be reproducible, or the derived artefact is not
  verifiable.
- **`beginArbitration` authority becomes a v2 contract question** (D5).
- **`/services` gains a third axis** — checkability, PII risk, and now jury-eligibility — which are
  correlated but not identical.
- **Value caps become load-bearing product copy**, not an internal parameter.
- **`ReputationStake` needs a slash path with a defensible trigger** (A1.2). `slash()` exists in the
  design and has never been executed — the staking flow itself has never been run end to end
  (`CC-072`). The retroactive audit is the first mechanism that would call it.
- **Retention becomes a joint parameter** with `ADR-0002` D4 (A1.2), not two independently chosen
  numbers.
- **`Security-Trust-Disclosure.md` gains a bootstrap-pool line** (A1.1), beside the oracle
  disclosure.

## Open items

- **The floor and ceiling numbers.** The floor is set by what a tier can pay; the ceiling by D6's
  stake bound. Neither can be chosen without a fee model, which does not exist (`ADR-0002` A1.2 —
  there is no platform fee today, deliberately, and it is also an AUSTRAC argument).
- ~~Where the pool comes from.~~ → **A vetted bootstrap pool** (A1.1). What remains open is the
  **exit condition**: the specific measure of "organic enough to dissolve the curated pool", which
  must be chosen before the pool exists, not after it is comfortable.
- **The joint retention / retroactive-audit window** (A1.2) — one number, two ADRs, currently unset.
- **Whether agents must stake to file a dispute** (A1.3 symmetry), and at what ratio.
- **Who performs redaction** — worker's device at capture, or the checker in its scratch pass. The
  first is better for `ADR-0002` D3 and worse for reproducibility.
- **Whether `beginArbitration` opens up**, and to whom.
- **Interaction with `ADR-0001` A2.4.** A verdict corrected during an incident and a panel ruling can
  race inside the same review window. Which wins is undecided.

## Handover — implementation order

Nothing here is scheduled. When it is:

1. Fee model, floor and ceiling (blocked on monetisation, `ADR-0002` D8's "trigger to watch").
2. Derived-artefact format, redaction pipeline, `derivedHash` — with `CC-083`.
3. Consent copy at acceptance and at `request_human_work` — with `CC-084`/`CC-088`.
4. T1 single-reviewer path only. **Ship T1 before T2**; a panel is the same machinery with more
   moving parts and worse economics.
5. `beginArbitration` authority and the arbitration clock — with the `ADR-0006` D3 contract change if
   the timing allows, otherwise v2.
6. T2 panel, commit-reveal, progressive slashing (`ADR-0001` D8).

Related: `ADR-0001` (D5, D7, D8, D9, A2.4), `ADR-0002` (D1, D3, D7), `ADR-0005`, `ADR-0006` (D3),
`CC-083`, `CC-084`, `CC-088`, `CC-011`, `docs/funds_control_aml_gating.md` (Track D).
