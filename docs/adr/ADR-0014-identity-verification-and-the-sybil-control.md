---
id: ADR-0014
title: Identity verification and the Sybil control
status: proposed
date: 2026-10-12
deciders: Aaron Clifft (pending; waiting on the authorities)
depends-on: ADR-0002 (D1, D3, D5, D8, Amendment 1), ADR-0004 (public claims), ADR-0013 (no stake)
supersedes: nothing yet. Would supersede ADR-0002 D1 and A1.1 only if option B or C is accepted
resolves: the KYC half of the first ADR-0013 draft, split out because it was never decided
area: compliance
epic: mainnet
---

# ADR-0014 — Identity verification and the Sybil control

## Context

`ADR-0013` removed the monetary stake. That leaves reputation as the only behavioural deterrent,
and reputation is cheap to farm: one person holding an agent wallet and a worker wallet can trade
tasks with themselves. Stake was the only control that cost the farmer anything.

Two records point at identity verification as the replacement:

- The draft AML/CTF program (Google Drive, 2026-10-02) applies customer due diligence to payer
  operators and contractors, and AUSTRAC enrolment was submitted on 2026-10-02, as recorded in the
  first draft of `ADR-0013`.
- Commit `b3000de` (2026-10-02) said *"Sybil resistance comes from KYC"*.

One record points the other way. `ADR-0002` D1 says there is **no identity verification, ever**, and
`ADR-0002` A1.1 kept that in force only until `CC-098`'s legal review said otherwise. The README
and Terms still say "No KYC".

**Aaron's position, 2026-10-12 (his words, paraphrased).** A wallet already identifies a persistent,
traceable actor, and if an authority needs to know who is behind one, the operator can be asked
(a John Doe style request) rather than verifying everyone up front. He has not decided to adopt
KYC and wants to see how far he gets with the authorities first. This is a working belief, not a
legal conclusion, and has not been tested with counsel or AUSTRAC.

The first draft of `ADR-0013` also contained a D3 choosing option B below. That text was drafted by
a session, not decided by Aaron, and has been removed from `ADR-0013` and moved here as an option.

## Decision

**Deferred.** No identity verification is built, and no public claim changes, until the authorities
and counsel have answered. Until then:

- `ADR-0002` D1 and A1.1 stand. The README's and Terms' "No KYC" wording is unchanged.
- The reputation score is not described as unfakeable or Sybil-resistant.
- Nothing is collected "just in case". Identity data is the heaviest thing this platform could hold,
  and holding it is hard to undo.

## Options

**A — Stay pseudonymous (`ADR-0002` D1 as written).** Wallets are the identity. Traceability rests
on the public chain and on responding to lawful requests. Cheapest and consistent with `ADR-0004`.
Open risk: if the platform is in AUSTRAC scope, customer due diligence is generally a duty owed
*before* providing the service, not a response to a later request. This is the question for counsel.

**B — Verified at the door.** The person or business that controls and funds an agent is verified
before any task is funded, and each contractor before their first payout. Prefer a regulated
party's assurance (a bank-backed digital ID such as ConnectID, or the Government Digital ID System
once it opens to private relying parties) over holding documents: the platform keeps a reference and
the result, and the provider keeps the documents. This applies `ADR-0002` D3/D5's minimisation
pattern to identity. An agent is never the customer. Toward the public the platform stays
pseudonymous; wallets and track records are what other users see.

**C — Verified above a threshold.** Pseudonymous below a value or volume cap, verified above it.
Reduces the data held and lets the platform start under A. Needs a cap design and an enforcement
point, and depends on the separate decision on escrow value caps.

**D — Analytics-led, with thin or no ID.** Wallet risk screening is the primary control. Both wallets
are screened before a task is funded and again before payout (CC-099 ships OFAC list screening now,
with an optional Chainalysis layer; a full blockchain-analytics provider such as Chainalysis, TRM
Labs or Elliptic would add transaction history and source-of-funds risk). Identity documents are
either not collected (as in A) or limited to a light check at a threshold (as in C). The argument for
D: document checks stop casual fraud but not organised launderers, who can forge or borrow
identities, whereas chain history cannot be forged and shows where funds came from and went. The
limits: analytics measures the risk of a wallet, not who the customer is, and whether it can stand
in for customer due diligence under the Act is a legal question for counsel, not an engineering
one (Q6(b) in the `CC-098` brief asks it, and the answer may be that simplified due diligence is the
route). It also does not tie a wallet to one human, so one person running many wallets is not caught.
D combines with A or C; it is not an alternative to them.

Under B or C identity data may never go on `humans`, which is world-readable by design (`CC-030`).

## Open items

1. Does AUSTRAC treat the platform as in scope, and if so what must be verified, when, and by whom?
   (`CC-098`; the lawyer brief; the answer from counsel and from AUSTRAC.)
2. If B or C: KYC provider, and whether a bank-backed digital ID can carry it.
3. Where identity data and its references live. The database is in ap-south-1 (Mumbai), so identity
   data there is an overseas disclosure under APP 8.
4. How an operator is bound to the agent wallets it runs. Agents authenticate with a wallet
   challenge only; there are no API keys to bind.
5. Record keeping. AML/CTF records are kept for 7 years, against `ADR-0002` D4's deletion at
   settlement plus the dispute window.
6. Whether the ATO sharing economy reporting regime applies, and if so, collecting its seller
   fields in the same design so identity is not collected twice.
7. Does wallet analytics (option D) satisfy, or reduce, any customer due diligence obligation, and
   which provider and coverage on Base would be needed? CC-099 still has Chainalysis Base coverage
   and the API contract unconfirmed.
8. Without a stake, is there any other cheap Sybil control (rate limits per wallet age, counterparty
   diversity in the score, value caps for new wallets) that would be enough on its own?

## Consequences if accepted

Option B or C reverses `ADR-0002` D1, so the "No KYC" and "no identity verification, ever" claims are
withdrawn from the README, Terms and privacy policy through `CC-014`'s pre-flip checklist, and the
`CC-098` lawyer brief's no-KYC premise is corrected. Option A keeps them and records that the
question was asked and answered.
