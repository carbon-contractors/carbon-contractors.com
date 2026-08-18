---
id: ADR-0002
title: Pseudonymity, task data retention, and the platform's privacy posture
status: accepted
date: 2026-08-13
amended: 2026-08-18 - D1 reaffirmed pending CC-098, see Amendment 1
deciders: Aaron Clifft
depends-on: ADR-0001 (D4 commitment scheme, D5 deterministic checker)
supersedes: the "Zero PII" design constraint in README.md
area: architecture
epic: public-launch
---

# ADR-0002 — Pseudonymity, task data retention, and the platform's privacy posture

## Status

**Accepted**, 2026-08-13. Replaces the `README.md` design constraint *"Zero PII — no personal data stored, ever."*

---

## Context

`ADR-0001` established that task evidence is committed on-chain as hashes while preimages live off-chain. That raised a contradiction the current `README.md` does not survive: a worker photographing a vehicle in a dealer's yard captures number plates, bystanders, staff, and a GPS trace of their own movements. *"No personal data, ever"* and *"the platform handles task evidence"* cannot both be true.

The resolution is not to weaken the claim. It is to make it **accurate and narrower**, and to build the architecture that makes the narrower claim structurally true rather than promised.

Two distinct data classes have been conflated:

| Class | Content | Controlled by | Volume |
| :---- | :---- | :---- | :---- |
| **Registration** | wallet address, service categories, rate, stake, reputation | the platform | low, stable |
| **Task payload** | acceptance spec, description, evidence artefacts | the hiring agent | unbounded, arbitrary |

The platform genuinely holds almost nothing in the first class. It should hold **nothing durable** in the second.

---

## Decision

### D1 — Pseudonymous by design; no identity verification, ever

The platform does not ask who anyone is, does not verify identity, and has no mechanism to do so. A wallet address and a chosen handle are the entire identity model. `pogojumper@gmail.com` is as valid as a legal name, and neither is checked, because neither is used for anything.

This is a **product decision, not merely a privacy one**. The `README.md` premise is *"No KYC, no resumes, no interviews. Just wallets, services, and outcomes."* Trust is established by staked capital and verifiable track record, not by identity. Introducing verification would not improve the trust model — reputation and stake already do that work — and would create the exact data estate this ADR exists to avoid.

**Say "pseudonymous", not "anonymous", and not "zero PII".** A wallet address plus a service history plus a payout pattern is pseudonymous data, not anonymous data, and under both Australian and EU law it can constitute personal information where an individual is reasonably identifiable. Overclaiming here is the kind of statement that gets quoted back from a public repo.

### D2 — Two separate statements, publicly, in place of one false one

`README.md`, `/learn` and the disclosure doc carry two claims, never merged:

1. **Registration.** The platform holds a wallet address, service categories, a rate, and derived reputation. It does not hold, request, or verify names, emails, phone numbers, documents or location. There is no account in the conventional sense.
2. **Task payload.** Task content is authored by the hiring agent and evidence is produced by the worker. It is arbitrary and may contain personal information about third parties. **The platform stores no task evidence and retains no task content after settlement.**

The second claim is only defensible because of D3 and D4. Do not publish it before they ship.

### D3 — The platform is not in the data path

Restates `ADR-0001` D4 as a standing constraint rather than an implementation detail.

- Evidence is written to a bucket the **hiring agent** nominates. They commissioned the work, they receive the work, they determine the purpose — they are the controller in substance, and this makes them the controller in fact.
- The deterministic checker receives a **time-limited URL**, reads, evaluates, and retains nothing. The checker runs stateless and writes no artefact other than the verdict.
- The platform persists `evidenceHash` and `verdictHash` only.

If the checker must operate on a local copy for reliability, that copy is scratch — held for the duration of the check, deleted on completion, never written to durable storage, never backed up.

### D4 — Task records are ephemeral, keyed to terminal state plus the dispute window

Deletion is not calendar-based. "Thirty days" is a round number chosen for convenience, which is precisely what a regulator asks about. Retention is tied to the last moment the data can still be needed.

| Field | Retained until | Then |
| :---- | :---- | :---- |
| Task description, acceptance spec | terminal state + dispute window closed | deleted |
| Evidence URL / any scratch copy | verdict posted | deleted immediately |
| Verdict breakdown (per-check results) | terminal state + dispute window closed | deleted |
| `specHash`, `evidenceHash`, `verdictHash` | — | retained (not personal data — see D6) |
| Wallet, amount, timestamps, outcome | — | already on-chain; DB row not required |

**Terminal state is not "complete".** Deleting on `Completed` alone would destroy the record while a dispute or challenge window is still open. The trigger is: state is terminal (`Completed`, `Expired`, `Resolved`) **and** every window that could reopen it has closed.

A task that settles cleanly in three days has its content gone on day four, not day thirty. Data minimisation — retain for exactly as long as the purpose requires — is the actual principle, and it is both the compliant answer and the lean one.

### D5 — The chain is the durable record; the database is a working set

This is what makes D4 safe, and it is the reason aggressive deletion does not break the product.

Everything the platform needs long-term already exists as on-chain events: task created, funded, submitted, completed, expired, resolved — with wallet addresses, amounts and timestamps. `README.md` already records on-chain reputation scoring from escrow event logs with a DB fallback.

Therefore:

- **Reputation survives deletion.** Completion count, volume, recency and stake are all derivable from event logs. Dropping the task row costs nothing.
- **Strike counts survive deletion** (`ADR-0001` D8). Consecutive expiries and dispute outcomes are events, not rows.
- **The `CC-075` AWOL signal survives deletion.** It counts `TaskExpired` against `WorkSubmitted` — both events.

The DB degrades to a **cache and a preimage store**. Nothing the platform depends on lives only there. Treat any feature that would require durable task content as a design smell to be resolved against the event log first.

### D6 — What is permanent and public, stated honestly

The counterweight to "nothing lingers". On-chain data is immutable and world-readable, forever: wallet addresses, amounts, timestamps, state transitions, and the three hashes.

This is not deletable and must not be described as if it were. Two things follow:

- **The hashes are the feature, not the liability.** `specHash` and `evidenceHash` are one-way commitments. Without the preimage they are not reconstructible and do not constitute personal information. Deleting the preimage satisfies an erasure request while leaving the chain record and the audit trail intact. This is the correct pattern for reconciling immutable ledgers with the right to erasure, and the architecture arrived at it while chasing tamper-evidence.
- **Pseudonymity is not anonymity, and workers must be told so.** A persistent wallet with a public task history is linkable. Chain analysis, an exchange on- or off-ramp, or a single careless disclosure can attach a real identity to it retroactively — and the history is permanent. Workers choosing to operate pseudonymously should be told this plainly in `/learn`, along with the practical mitigation (a fresh wallet trades reputation for unlinkability). Anything less is a privacy claim the platform cannot keep.

### D7 — Notice at task creation, in both directions

Neither party can be assumed to have thought about this. The agent is a language model; the worker is in a car yard with a phone.

- **To the agent, at `request_human_work`:** the spec and description must not request personal information beyond what the task requires; you receive and control the resulting evidence; you are the controller of it. Note the spec itself can carry personal information — *"go to 42 Smith St, ask for Dave"* — and the description field is currently stored unauthenticated (`CC-081` Defect 4).
- **To the worker, before acceptance:** what you capture may contain third parties' personal information, and you are the one creating it. Shown alongside the acceptance spec, not buried in terms.

**Category-level control is the cleaner lever.** Some service categories should be prohibited from PII-bearing tasks outright. This pairs with the checkability tiering already in `ADR-0001` — the categories with no meaningful automated check are largely the same ones with the highest PII risk.

### D8 — Regulatory posture

Recorded because it was researched and the reasoning should not be re-derived later. **None of this is legal advice and `CC-051` still needs a lawyer.**

- **Turnover, not profit.** The Australian small business exemption threshold is $3M of gross income from all sources for the whole legal entity, assessed on the prior financial year. A platform that breaks even or runs at a loss is still measured on gross income. Escrowed USDC never passes through the platform and is arguably not its income at all — only a platform fee would be — which is a second benefit of the non-custodial design, and a question for an accountant.
- **No charitable carve-out.** Not-for-profits sit under the same turnover test. Donations and grants count as income. Restructuring as an NFP would not create an exemption and would constrain the platform fee and the `ADR-0001` D8 adjudication market. **Do not structure for the exemption.**
- **The statutory tort ignores the exemption.** Serious invasions of privacy have been actionable since 2025 regardless of whether an entity is covered by the Privacy Act. Exempt status is no defence if third-party imagery leaks. This is the highest-weighted risk here and it is exactly what D3 and D4 mitigate.
- **GDPR is the binding constraint.** No turnover threshold, no charitable carve-out, extraterritorial reach. One EU worker or agent and it applies in full. **Design to GDPR and the Australian question largely resolves itself.**
- **Monetisation is the trigger to watch.** The "trades in personal information for a benefit" exception applies regardless of turnover. A free marketplace disclosing worker profiles to hiring agents has a weak "for a benefit" limb. Introducing the platform fee in the `README.md` roadmap strengthens it materially. Raise before monetising, not after.
- **Reform is direction, not date.** The blanket $3M exemption has not been repealed; removal sits in an undated second tranche. Plan for arrival, do not build around a date.
- **Voluntary opt-in (s6EA) is a live option.** A platform whose entire pitch is verifiable trust could opt in to Privacy Act coverage. Consistent with publishing the checker and with `ADR-0001` D9 — it converts "too small to be regulated" into "chose to be". Real obligations once in; revisit at monetisation.

### D9 — Deletion must be verifiable, and `DELETE` is not deletion

An unverifiable deletion claim has the same shape as an unfalsifiable verdict, and `ADR-0001` D9 rejected that pattern. Publish the retention rule, emit a deletion record (task id, timestamp, retention rule version), make it auditable.

**Three implementation traps that would make the claim false:**

- **Backups and point-in-time recovery.** Supabase retains automated backups and PITR for a configured window. Rows deleted from the live table persist there for the full retention period. If the claim is "nothing persists", either exclude task content tables from PITR, shorten the window below the retention period, or — cleanest — **never write task content to a backed-up table in the first place.** Prefer the third: hold task content in a separate unbacked store, or don't hold it.
- **Postgres MVCC.** `DELETE` marks tuples dead; the data remains in the heap until vacuumed, and in the WAL until it ages out. For content that must be provably gone, overwrite before deleting, or keep it out of Postgres entirely.
- **Logs.** `README.md` records structured Wazuh-compatible logging. If task descriptions, evidence URLs or spec contents reach log lines, deleting the row achieves nothing. Audit log statements for payload content and redact at source. This is the most commonly missed one.

Note also: the intent is row deletion (`DELETE`, or partition drop), not `DROP TABLE`. Partitioning task content by settlement week and dropping whole partitions is the cleanest mechanism — no MVCC residue, no vacuum dependency, one DDL statement.

---

## Consequences

- **`README.md` "Zero PII" is replaced** by the D2 two-part statement. This is a correction of an inaccurate public claim and should ship with the other copy corrections in `ADR-0001`'s handover.
- **The `/learn` module gains a pseudonymity-versus-anonymity section** (D6). Workers are being asked to make a durable, irreversible linkability decision at registration and currently are not told so.
- **No feature may depend on durable task content.** Enforced by D5. Any that would must be resolved against the event log or explicitly re-open this ADR.
- **The agent becomes the evidence controller**, which needs stating in the terms as well as the notice, and requires the spec schema to carry a bucket target.
- **Compliance surface shrinks to a notice obligation** rather than a data estate. That is the point of the whole design.

## Open items

- Dispute-window duration, inherited from `ADR-0001`'s open items — it sets the retention period.
- Whether the platform holds *any* scratch copy of evidence, or the checker streams from the agent's bucket only.
- Storage target for task content: unbacked table, separate store, or none.
- Whether a minimal settlement record is required for the platform's own audit purposes independent of the chain, and if so what the absolute minimum is.
- ~~AML/CTF exposure of a marketplace routing USDC with no identity verification — adjacent to
  this ADR, not resolved by it, and a lawyer question alongside `CC-051`.~~ → **Ticketed
  2026-08-18.** `CC-098` carries the AUSTRAC AML/CTF Tranche 2 (VASP) classification question
  specifically — distinct from `CC-051`'s ASIC/DAP scope — including the direct tension it creates
  with D1 if customer due diligence turns out to be required. `CC-099` carries sanctions/PEP
  wallet screening, which is compatible with D1 as written (address-based, not identity-based)
  and does not wait on `CC-098`'s answer. Still a lawyer question, not resolved by either ticket.
  **D1 itself reaffirmed 2026-08-18 — see Amendment 1.**

## Amendment 1 — 2026-08-18 — D1 reaffirmed; sanctions screening is the operative control, not identity verification

Raised while scoping `CC-098` (AUSTRAC AML/CTF Tranche 2 classification) and `CC-099` (sanctions
screening), which both landed on the question this ADR's open items already flagged but left
unresolved: if AML/CTF obligations turn out to attach, does D1 survive?

### A1.1 — Aaron's position, recorded so it is not re-litigated

Stated 2026-08-18: the intent is to **abide by AML/sanctions obligations in full**, including
doing whatever is reasonably required to stop a known flagged wallet from accessing the
platform — that commitment is unconditional, applies now, and is what `CC-099` builds regardless
of how `CC-098` resolves.

It is a **separate and deliberate decision not to pre-emptively add identity verification** on
the strength of an unresolved classification question alone. **D1 stands** — pseudonymous by
design, no identity verification — until `CC-098`'s legal review concludes it must not. This is a
considered call, not an oversight: sanctions/address screening is a scoped, address-based control
that ships either way; full identity-based CDD is a much larger architectural change (it would
touch `humans`, the whitepages design, and the entire "no KYC" product premise) that should be
built if and when required, not spent pre-emptively against a question still open with counsel.

### A1.2 — The fee distinction, as an argument for counsel, not a conclusion

`CC-098` records two competing AUSTRAC precedents on who counts as "the customer" in a two-sided
designated service: real estate brokering (both parties are customers) versus a solicitor's trust
account (only the instructing client is). Aaron's position, worth putting to the lawyer directly:
the brokering precedent describes a party paid a **fee** for arranging the two-sided transaction.
Carbon Contractors currently charges **no platform fee** — consistent with the stated position of
no personal revenue accrual until the project proves viable, and with D8's own note that
introducing a fee is "the trigger to watch" for a related exception.

**Where this helps:** it is a real, relevant fact that goes directly to which of `CC-098`'s two
precedents is the closer analogy.

**Where it may not carry the whole question:** AUSTRAC's guidance is that even occasional,
non-fee-feeling provision of a designated service can trigger obligations once an activity is
"carrying on a business" — so the fee argument likely narrows *who counts as a customer* rather
than removing the designated-service question altogether. Brief the lawyer on both the argument
and this limit, not the argument alone.

---

## Handover — implementation order

1. **Retention job** — delete on terminal state plus closed dispute window; partition-drop mechanism preferred over row `DELETE`.
2. **Log audit** — confirm no task description, spec content or evidence URL reaches a log line; redact at source.
3. **Backup/PITR review** — task content excluded from backed-up storage, or not stored.
4. **Evidence path** — checker streams from an agent-nominated bucket via time-limited URL; no durable local copy. Spec schema gains a bucket target field.
5. **Notice** — agent-facing at `request_human_work`, worker-facing before acceptance.
6. **Deletion records** — emitted, auditable, retention rule versioned.
7. **Copy** — `README.md` constraint replaced; `/learn` pseudonymity module added.
8. **Category policy** — PII-prohibited categories encoded in `/services`.
9. **Drop the `waitlist` table and remove the coming-soon capture form.** This is a **prerequisite for the D2 copy**, not tidying: the waitlist is the only place the platform holds email addresses, so until it is gone, *"the platform holds no email addresses"* is false. The copy change and the drop ship together, or the published claim is wrong on day one. Confirmed 2026-08-13 as the intended action at launch; recorded here so it is not lost in launch-day noise.

Related: `ADR-0001`, `CC-051`, `CC-081` (Defect 4), `CC-075`, `CC-036`.
