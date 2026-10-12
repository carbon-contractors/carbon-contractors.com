---
id: ADR-0013
title: No stake, no fee — identity verification replaces stake as the Sybil control
status: proposed
date: 2026-10-12
deciders: Aaron Clifft (pending)
depends-on: ADR-0002 (D1, D8, Amendment 1), ADR-0001 (D7 reputation, D8 jury sketch), ADR-0004 (public claims), ADR-0007 (staked tiers)
supersedes: ADR-0002 D1 and A1.1, on acceptance
amends: ADR-0007 (its reviewer stakes and stake-derived value ceiling lose their basis; redesign left open)
resolves: NOR-537 F2; the staking and fee contradiction between commit b3000de and the draft AML/CTF program (both dated 2026-10-02)
area: compliance
epic: mainnet
---

# ADR-0013 — No stake, no fee, and identity verification as the Sybil control

## Context

Three records disagreed for ten days.

- **NOR-537 F2 (2026-10-02).** `ReputationStake.slash()` sent a worker's staked USDC to the contract
  owner, at the owner's discretion, with no on-chain link to a dispute. It was the one place the
  platform could take a user's USDC, and a third destination outside the two-party escrow.
- **Commit `b3000de` (2026-10-02)** removed the stake contract with the message *"no monetary stake;
  reputation is non-monetary and Sybil resistance comes from KYC"*. It recorded the decision nowhere
  else, and left the app's stake surface in place.
- **The draft AML/CTF program (Google Drive, dated 2026-10-02)** recorded the opposite: keep staking
  without slashing, and fund gas and running costs from a disclosed per-job fee. The 2026-10-09 quote
  requests to three law firms described a "refundable worker stake" on the same basis.

Meanwhile the draft program applies customer due diligence to payer operators and contractors, and
AUSTRAC enrolment was submitted on 2026-10-02. Both contradict `ADR-0002` D1 (*"no identity
verification, ever"*), which `ADR-0002` A1.1 kept in force only until `CC-098`'s legal review said
otherwise.

On 2026-10-12 Aaron settled it: no stake of any kind, and no monetisation plan. Carbon Contractors is
a self-funded learning (capstone) project, and staying outside the AFSL regime matters more than
anything a stake or a fee would buy.

## Decision

### D1 — No monetary stake

Workers do not lock USDC with the platform, slashable or refundable. Reputation is non-monetary: it
is computed from the on-chain task record (`ADR-0001` D7) and nothing else.

A refundable stake was the last version on the table and is rejected with the rest. Even without
slashing, it holds users' USDC in a contract the operator deploys and administers, which is a
stored-value, non-cash payment facility or custody question in its own right, for a trust signal
that 20 USDC barely provides.

### D2 — No platform fee and no monetisation plan

The platform charges nothing on any task. The operator self-funds hosting and running costs.
Agents and workers pay their own gas, as they already do.

Introducing any fee or revenue reverses this ADR. It is also a review trigger for the AML/CTF
program, for the AFSL position, and for the Privacy Act small-business position (`ADR-0002` D8 already
names monetisation as "the trigger to watch"). `ADR-0002` A1.2's no-fee argument stands, and is now
a standing commitment rather than a current fact.

### D3 — Identity verification replaces stake as the Sybil control

On acceptance this supersedes `ADR-0002` D1 and A1.1. It sets the direction only; the design is open
(see Open items).

- **Who.** The person or business that controls and funds an agent, before any task is funded; and
  each contractor, before their first payout. An agent is never the customer (draft AML/CTF program,
  *Business profile*).
- **How.** Prefer a regulated party's assurance over holding identity documents: the platform keeps a
  reference and the result, and the provider keeps the documents. This is `ADR-0002` D3/D5's
  minimisation pattern applied to identity.
- **Where it may never go.** Not on `humans`, which is world-readable by design (`CC-030`).
- **Public claims.** Toward the public the platform stays pseudonymous: wallets and track records are
  what other users see (`ADR-0004`). The "No KYC" and "no identity verification, ever" claims are
  withdrawn from the README, Terms and privacy policy, through `CC-014`'s pre-flip checklist.

## Consequences

- **Code.** The leftover stake surface goes: dashboard stake and unstake controls, the stake
  component of the reputation score, the MCP `reputation_stake_config` resource,
  `scripts/admin/record-slash.ts`, and the `stake_slashes` table (by a new migration). The testnet
  `ReputationStake` deployment stays recorded in `chain-constants.json` as history.
- **`ADR-0007`.** Its staked reviewers and stake-derived value ceiling lose their basis. The tier is
  not built yet, so this costs nothing today, but it must be redesigned before it is.
- **Reputation is now the only behavioural deterrent,** and one person holding an agent wallet and a
  worker wallet can farm it. Identity verification on both sides is what makes counterparty
  diversity checkable; until then the score should not be described as unfakeable.
- **Documents to correct:** the `CC-098` lawyer brief (its no-KYC premise), the draft AML/CTF
  program (staking and fee lines), the 2026-10-09 quote requests (refundable stake), and the
  README, Terms and privacy policy.
- **AFSL.** Removing stake and fee removes two hooks. The escrow itself remains the open question:
  the owner's dispute power and the platform-held verdict key. That belongs to a separate decision
  on value caps and adjudication, not to this one.

## Open items

1. KYC provider, and whether an Australian bank-backed digital ID (ConnectID, or the Government
   Digital ID System once it opens to private relying parties) can carry it.
2. Where identity data and its references live. The database is in ap-south-1 (Mumbai), so identity
   data there is an overseas disclosure under APP 8.
3. How an operator is bound to the agent wallets it runs. Agents authenticate with a wallet challenge
   only; there are no API keys to bind.
4. Record keeping. AML/CTF records are kept for 7 years, against `ADR-0002` D4's deletion at
   settlement plus the dispute window.
5. Whether the ATO sharing economy reporting regime applies, and if so, collecting its seller fields
   in the same design so identity is not collected twice.

## Rejected alternatives

| Option | Why not |
| :-- | :-- |
| Keep the stake with slashing (the original contract) | A third, discretionary destination for users' USDC. NOR-537 F2. |
| Keep a refundable stake without slashing (draft program, 2026-10-02) | Still a platform-administered contract holding users' USDC, for little trust value. Rejected 2026-10-12. |
| A disclosed per-job fee | No monetisation plan; a fee strengthens the "carrying on a business" and paid-broker readings. Rejected 2026-10-12. |
| Stay KYC-free (`ADR-0002` D1 as written) | Inconsistent with the draft AML/CTF program and the AUSTRAC enrolment, and leaves no Sybil control once stake is gone. |
