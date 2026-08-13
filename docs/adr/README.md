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

`ADR-0001` carries an **Amendment 1** (same date) that changed D4, D6 and D9 — verdicts became
EIP-712 signatures rather than platform transactions, and settlement became pull-payment. Read the
amendment; several decisions above it are restated by it.

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

`ADR-0001` first — the other two depend on it. `ADR-0002` and `ADR-0003` can be read in either
order, though `ADR-0003` refers to `ADR-0002`'s retention decisions.
