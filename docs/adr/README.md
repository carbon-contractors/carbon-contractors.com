# Architecture Decision Records

Design decisions that are too large, too cross-cutting, or too consequential to live inside a
backlog issue. Added August 2026.

## Why these exist separately from `docs/backlog/`

A backlog issue answers *"what is wrong and what should we do about it."* An ADR answers *"which of
several defensible designs did we choose, and why did we reject the others."*

The distinction stopped being academic with `CC-081` Defect 2 and `CC-075`. Both were filed with a
**"Fix — deliberately not specified"** section, because guessing would have been worse than waiting.
Both turned out to be asking the same question — *who wins when a party stops participating* — and
answering it required deciding what a completed task even is. That answer does not fit in an issue
note, and burying it in one would mean the reasoning is lost the next time someone proposes
"couldn't the agent just resolve its own dispute?"

So: **an issue that gets stuck on a design question gets an ADR, and the issue records the
consequence.** The issue stays open until the work is done; the ADR is accepted once the decision is
made.

## Index

| ADR | Title | Status | Resolves |
| :-- | :-- | :-- | :-- |
| [ADR-0001](ADR-0001-escrow-resolution-and-dispute-authority.md) | Escrow resolution, evidence commitments, and dispute authority | accepted | `CC-081` Defect 2, `CC-075` |
| [ADR-0002](ADR-0002-pseudonymity-and-task-data-retention.md) | Pseudonymity, task data retention, and the platform's privacy posture | accepted | supersedes "Zero PII" (`CC-027`) |
| [ADR-0003](ADR-0003-monitoring-as-correctness-dependency.md) | Monitoring as a correctness dependency, not an ops nicety | accepted | rescopes and splits `CC-040` |
| [ADR-0004](ADR-0004-public-claims-and-pseudonymity.md) | Public claims — copy describes the target state, and the identity claim is pseudonymity | accepted | two positions `CLAUDE.md` kept re-litigating |
| [ADR-0005](ADR-0005-worker-acceptance-and-offer-lifecycle.md) | Worker acceptance, the offer lifecycle, and concurrency limits | accepted | the worker never consented to being hired |
| [ADR-0006](ADR-0006-continuity-succession-and-the-right-to-fork.md) | Continuity, succession, and the right to fork | accepted | `CC-091`, `funds_control_aml_gating.md` Track C |
| [ADR-0007](ADR-0007-adjudication-tier-and-arbitrator-isolation.md) | The adjudication tier — value-weighted review, and what an arbitrator may see | accepted | `funds_control_aml_gating.md` Track D |
| [ADR-0008](ADR-0008-completion-attestations.md) | Completion attestations — a signature the worker holds, not a transaction we send | **proposed** | `CC-036` |
| [ADR-0009](ADR-0009-session-auth-and-signing-hygiene.md) | Session auth and signing hygiene — sign once at connect, then only when the chain is touched | accepted | `NOR-322` (CC-101) |
| [ADR-0010](ADR-0010-evidence-upload-presigned-agent-bucket.md) | Evidence upload — pre-signed writes into the agent's bucket, not platform storage | **proposed** | `NOR-334` (CC-101) |

`ADR-0001` carries three amendments, and each changes decisions stated above it:

- **Amendment 1** (same date) changed D4, D6 and D9 — verdicts became EIP-712 signatures rather than
  platform transactions, and settlement became pull-payment.
- **Amendment 2** (2026-08-16) scoped D3 — `specHash` binds the machine-checkable criteria and the
  schema version but **not** the prose, and spec schemas are **never migrated in flight**. It also
  records why the platform cannot refund an in-flight task, which is a bytecode fact rather than a
  policy choice.
- **Amendment 3** (2026-08-26) corrected D3's illustrative spec — `phash_max_similarity_to.source`
  carries the reference hashes inline rather than a label for a set, because D5's offline checker
  cannot resolve a label, and the criterion is a **cap** that fails closed. A3.4 records why the
  inversion survived five days: it was the only criterion with no failing canary case.

`ADR-0002` carries one amendment:

- **Amendment 1** (2026-08-18) reaffirms D1 (no identity verification) pending `CC-098`'s AUSTRAC
  classification, and records the fee-based argument for why Carbon Contractors may not sit on the
  same footing as a paid broker for who counts as "the customer" in a two-sided designated service.

## Convention

Frontmatter fields in use:

```yaml
id: ADR-0001
title: ...
status: accepted | proposed | superseded
date: 2026-08-13
deciders: ...
depends-on: ADR-0002 (D4 retention)      # optional
supersedes: ...                          # optional — what this replaces
amends: CC-080 (clarifies ...)           # optional — issues whose meaning changes
resolves: CC-081 Defect 2, CC-075        # optional — open questions this closes
blocks: CC-036, CC-072, CC-077           # optional — work that must wait for it
area: architecture | infra | contracts
epic: public-launch
```

Decisions are numbered `D1`, `D2`, … and referenced as `ADR-0001 D2` from issues and code comments,
so a reader can find the exact clause rather than the whole document.

Every ADR ends with a **Handover — implementation order** section. That list is the source of the
backlog items, and each item should map to an issue or be explicitly folded into one. When adding an
ADR, scan the existing backlog before filing new issues — most handover steps land on something that
already exists.

These are **not** validated by `scripts/backlog.mjs`, which only reads `docs/backlog/CC-*.md`. Keep
the index table above current by hand.

## Reading order for a fresh session

`ADR-0001` first — the others depend on it, and **read its Amendment 1**, which supersedes several of
its own decisions. `ADR-0002` next. `ADR-0003` refers to `ADR-0002`'s retention decisions, and
`ADR-0004` restates `ADR-0002` D1/D6 as an operational rule.

**`ADR-0006` and `ADR-0007` were accepted 2026-08-26** with execution parameters; both were drafted
during the 2026-08-19 documentation-alignment review (`docs/design-review-2026-08-19.md`).

- **`ADR-0006`** carries the two contract-level items that must land with `CC-034` or not at all for
  v1: the **arbitration deadline in bytecode** (D3) and **2-of-4 Safe ownership** (D2). Its Status
  section holds the accepted parameters, including custody (Aaron two keys in two buildings, two
  family members one each) and D11's custody-escalation triggers. What the parameters do *not* settle
  is the family-only signing rehearsal, the estate packet, and the legal instrument — all three
  human rather than technical.
- **`ADR-0007` is accepted but not scheduled** (epic `v2`). What acceptance bought is A1.1's exit
  test — six published thresholds for when the bootstrap juror pool dissolves — chosen before the
  pool exists rather than after it gets comfortable.

`ADR-0005` is the only accepted one that is **not** about money, custody or claims — it is the matching layer,
and it needs no contract knowledge to read. Read it before touching the hire path, `CC-074`,
`CC-075`, or anything that assumes a worker agreed to a task.

**`ADR-0004` is the one to read before editing any website copy.** It exists because two positions —
that pre-launch copy describes the target state, and that the optional notification email is not a
PII contradiction — were settled in conversation, lived nowhere durable, and were then re-litigated
repeatedly. `CLAUDE.md` points at it rather than restating it, deliberately: that file is read at the
start of every session and had grown to 405 lines carrying five stale claims.
