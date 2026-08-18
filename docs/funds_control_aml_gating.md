# Definition of done — control & AML/sanctions gating checklist

Synthesis of the 2026-08-17 conversation thread (progress assessment → AML/sanctions screening → escrow control analysis). This is the explicit, ticket-linked answer to "how much work is left," reframed as concrete markers rather than a percentage.

## Two distinct finish lines

1. **Regulatory compliance** — what AUSTRAC registration/sanctions law actually requires. Having an owner-gated admin override is normal and permitted for a registered VASP.
2. **Aaron's stricter personal bar** — genuinely cannot unilaterally decide fund outcomes, full stop ("actually do my best to not enable ML," stated 2026-08-17).

Most work serves both. One item below (the `resolveDispute` override) is required only for #2, not #1 — flagged explicitly.

## Track A — Already ticketed, sequenced, sized (finishing work, already counted in the 55–65% estimate)

| Ticket | Status | What "done" means |
|---|---|---|
| CC-084 | P0, in-progress | Machine-checkable acceptance spec, versioned, committed before work is accepted. Foundation everything below sequences behind. |
| CC-083 | P0, to-do (blocked behind CC-084) | Deterministic evidence checker + canary fixture. Byte-identical verdict on re-run, offline, on a different machine. No LLM, no network calls. |
| CC-092 | P0, to-do (blocked behind CC-084) | The entire missing v2 write path: submitWork, verdict service (EIP-712 signing), claim path (releaseAfterReview/claimWithVerdict), and a rewritten dispute_task that actually carries a signed verdict instead of a bare assertion. |
| CC-085 | P0, in-progress | Invariant monitors, including verify-checker — continuously re-verifies the canary set, not just "is the checker up." |
| CC-036 | Roadmap/optional | EAS attestations — independent, publicly-verifiable record of task completion. Strengthens auditability; not required for the mechanism to be non-discretionary. |

## Track B — Under-prioritized relative to the stated goal

| Ticket | Status | Gap |
|---|---|---|
| CC-090 | P2, to-do | Separates verdict-signing key from owner key. Its own priority reasoning is scoped to the *compromise* threat model only ("anyone who could forge a verdict could instead call resolveDispute directly, which is strictly more powerful"). Doesn't address the *structural* question of whether the operator should be distinct from the adjudicator at all. Worth re-rating given the actual goal. |

## Track C — No ticket exists. New gap surfaced by this conversation.

**`resolveDispute` is `onlyOwner` and settles disputes directly and unilaterally.** Nothing in the current 97-ticket backlog proposes removing, timelocking, or reassigning this. This is the one concrete thing standing between "the code is structured so I can't adjudicate" being aspirational and being literally true. This is a decision, not an engineering task — options:

- Leave it as emergency-only, but gate it behind a timelock or multisig so it's not unilateral even in principle.
- Renounce/remove it once the algorithmic path (Track A) has proven reliable in production — true Tornado-Cash-style, but no recourse if the checker traps funds on a bug.
- Route it through the jury mechanism (Track D) rather than through the owner alone.

Needs its own ticket once a direction is chosen.

## Track D — Designed on paper, entirely unscoped

**ADR-0001 D8, the "jury tier"** for genuinely subjective disputes (the "3rd party registered user double-checks hash states" idea) — explicitly deferred to v2, "undesigned beyond a paragraph" per ADR-0001's own text. No economics, no juror selection mechanism, no anti-collusion design, no ticket. Likely the single largest true unknown in the whole adjudication stack.

## Track E — Separate concern: AML/sanctions (from the earlier part of this thread)

- Chainalysis sanctions oracle integration (`isSanctioned()` check on both wallets in createTask/completeTask or the MCP request_human_work handler) — cheap, scoped, no ticket yet. Should gate CC-034 (mainnet).
- CC-051 (AUSTRAC/Digital Assets Framework classification) — depends on AUSTRAC guidance, not fully in Aaron's control.

## Net effect on the original progress estimate

Doesn't materially move the aggregate percentage — Track A was already counted in the 2026-08-17 progress assessment's 55–65% estimate. What changed: two previously-vague "future unknown-unknown" line items (the override question, the jury tier) are now named, concrete, ownable decisions instead of unnamed risk. That's real progress independent of resolving either one.
