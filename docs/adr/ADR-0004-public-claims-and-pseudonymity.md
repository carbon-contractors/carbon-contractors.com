---
id: ADR-0004
title: Public claims — copy describes the target state, and the identity claim is pseudonymity
status: accepted
date: 2026-08-13
deciders: Aaron Clifft
depends-on: ADR-0002 (D1 pseudonymous by design, D2 two statements, D6 what is permanent)
area: content
epic: public-launch
---

# ADR-0004 — Public claims: target-state copy, and pseudonymity

## Status

**Accepted**, 2026-08-13. Records two standing positions that had been settled in conversation but
lived nowhere durable, and were therefore re-litigated repeatedly — including several times in a
single session by an agent that had no record of the decision.

Written to be pointed at from `CLAUDE.md` rather than restated there.

---

## Context

Two questions kept resurfacing, and both had already been answered:

1. *"This copy describes something the build does not do yet — is that a defect?"*
2. *"The README says no PII, but `notification_channels` stores email addresses — isn't that a
   contradiction?"*

Both are reasonable readings of the repository as it stands. Both are wrong, and re-deriving them
costs time and produces churn against copy that is deliberate. `ADR-0002` settled the substance of
the second; neither had a home for the *operational* consequence.

---

## Decision

### D1 — Site copy describes the state the build is heading towards

**Nothing is live.** The coming-soon gate is up and does not lift until after the mainnet migration
(`CC-039` → `CC-014`, the literal last gate in the backlog). No member of the public has read a word
of `/learn`, the README, or the legal pages.

So copy is written forward, on purpose. `/learn` Module 7 describing evidence hashing and
task-content deletion is `CC-083` and `CC-087` waiting to land — the copy is ahead of the build
rather than wrong about it.

Consequences:

- **Do not "correct" forward-looking copy to match the current build.** Check whether a ticket
  already owns the gap before treating it as a defect.
- **If you add a claim that outruns the build, add it to `CC-014`'s pre-flip checklist in the same
  commit.** That is the whole mechanism.

### D2 — The control is the gate, not perpetual accuracy

Aaron's position, stated 2026-08-13: *"before I go public and start broadcasting this to the world,
every word of website copy needs to be validated against the build state."*

`CC-014` therefore carries a checklist that is verified before `NEXT_PUBLIC_COMING_SOON` flips —
retention passing, waitlist dropped, evidence path live, README staking and dispute copy matching.
**If a box is unticked, the gate does not lift.**

This is deliberately a gate rather than a rule that copy must always be true today. A rule would
mean writing copy twice; a gate means writing it once and proving it before anyone reads it.

### D3 — What is still a genuine defect

The distinction matters, because D1 is not a licence to write anything.

- A claim that **will never be true**, or describes something nobody intends to build.
- A claim about a **third party**. `CC-029`'s *"we're a Stables affiliate partner"* was not early —
  it was false about someone else's commercial relationship, with no affiliate link behind it, for a
  provider that was winding down. That is a different category from being ahead of your own roadmap
  and it gets fixed immediately, not gated.

The test: *would this be false even after everything we intend to build has shipped?* If yes, it is a
defect now.

### D4 — The identity claim is pseudonymity, and the optional email is not a contradiction

Restates `ADR-0002` D1/D6 as an operational rule, because the objection recurs against the code
rather than against the ADR.

- The platform asks for no identity, verifies none, and has no mechanism to. A wallet address and a
  chosen handle are the entire identity model.
- **An optional notification address is not identity verification.** It exists so a worker can be
  told they have been hired; without it the product does not function (`CC-005`, `CC-073`). Nothing
  reads it as identity, nothing verifies it, and none is required.
- **Preferred channel order: webhook, Telegram, or Discord over email.** Email is the least private
  and the least aligned with an agent-native design — but a worker who wants old-school email is
  **not blocked.** Deliberate accessibility call, not an oversight.

### D5 — Why that is structurally safe, not just policy

The contact address lives on `notification_channels`, where `anon` and `authenticated` hold **no
privileges at all** after migration `015` (`CC-062`) — a denied read returns `401` with SQLSTATE
`42501`, at the ACL layer, before RLS is consulted.

Contrast `humans`, which is deliberately anon-readable as the public whitepages (`CC-030`).

So the one piece of contact data a worker may supply sits behind two independent barriers, on the
table that is *not* world-readable. **Never move a notification address onto `humans`.**

### D6 — The honest direction is the opposite one

The thing worth warning workers about is not that the platform holds an email. It is that
**on-chain history is permanently linkable to a real identity if someone digs hard enough** — via a
cash-out, a reused address, a reused handle, or wallet clustering. And it resolves *backwards*: the
moment anything links the wallet, the entire history resolves at once, and nothing can delete it.

Aaron's framing: *"I don't want or need your PII, but there will be identifiable history linked to
on-chain activities if one was to dig deep enough."*

That is stated plainly to workers in `/learn` Module 7 rather than hidden behind a "zero PII" claim.
Module 7 exists precisely because this tension is real and the answer is disclosure, not denial.

### D7 — Vocabulary

In any copy, issue, or commit message: **say "pseudonymous". Never "anonymous", and never "zero
PII".**

A wallet plus a service history plus a payout pattern is pseudonymous data, and under both
Australian and EU law it can constitute personal information where an individual is reasonably
identifiable. `CC-027` carries the README correction that replaces the old "Zero PII" constraint.

---

## Consequences

- `CLAUDE.md` carries a short pointer to this ADR instead of two long sections. That file is read at
  the start of every session, and it had grown to 405 lines with five stale claims in it — long
  prose there is expensive to maintain and quietly goes wrong.
- `CC-014` gains the pre-flip checklist as a hard gate.
- Copy review becomes a launch-gate activity rather than a continuous one.

## Open items

- Whether the pre-flip checklist should be machine-checked rather than a human checklist. Several
  items already have monitors (`verify-retention` in `CC-085`); the rest do not.
- Whether `/services` should discourage email channels at registration rather than merely ranking
  them last (`CC-073`, `CC-088`).

Related: `ADR-0002` D1/D2/D6, `CC-014`, `CC-027`, `CC-029`, `CC-062`, `CC-073`, `CC-083`, `CC-087`,
`/learn` Module 7.
