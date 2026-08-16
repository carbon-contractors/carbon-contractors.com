---
id: ADR-0005
title: Worker acceptance, the offer lifecycle, and concurrency limits
status: accepted
date: 2026-08-16
deciders: Aaron Clifft
supersedes: none
amends: CC-074 (the toggle becomes enforcement), CC-075 (a cleaner AWOL signal)
resolves: the worker never consents to being hired
blocks: CC-084 (worker-facing spec display), CC-092
area: architecture
epic: public-launch
---

# ADR-0005 — Worker acceptance, the offer lifecycle, and concurrency limits

## Status

**Accepted**, 2026-08-16.

---

## Context

Found while scoping `CC-084`. The question that surfaced it was a product one — *"can two workers
both do the same job and one of them lose the race?"* — and answering it exposed something worse
than the thing being asked about.

### There is no race, and that is not the reassuring part

`CarbonEscrow.createTask` names one `worker` address at funding, and `submitWork` requires
`msg.sender == task.worker` (`contracts/CarbonEscrow.sol:293`). A funded task belongs to exactly one
wallet. **Two workers cannot both do the job, so nobody can be beaten to the finish line.**

But the reason there is no race is that **the worker was never asked.** An agent picks them out of
`search_whitepages`, funds a task naming their address, and they find out afterwards — if they find
out at all.

### Three things verified in the tree, 2026-08-16

1. **`accepts_auto_booking` is never enforced.** `getAutoBookableContractors()`
   (`src/lib/db/notifications.ts:79`) is a directory listing for agents, not a gate.
   `request_human_work` never reads the flag. A worker with it **false** — the default, and
   `CC-074` records that every website registration sits there — can still be named on a funded task
   with no say in it.
2. **No notification delivery exists anywhere in `src/`.** Channels can be registered and are never
   written to. `src/lib/payments/x402.ts:106` tells the hiring agent *"the worker is notified"* as
   step 3 of the funding instructions. Nothing sends anything; a worker learns they have been hired
   by loading the dashboard.
3. **`/learn` module 5 describes the flag as a working lever.** *"When it's `false` (the default,
   and where every website registration currently sits), you're notified and decide yourself."*
   Neither half is implemented — there is no notification and there is no decide step.

Point 3 is not an `ADR-0004` forward-looking-copy case in the usual sense. It describes a control the
worker is told they hold, and the control does not exist. It goes on `CC-014`'s pre-flip checklist.

### What the delivery platforms do, and the one way we differ

DoorDash and Uber Eats use a **directed offer with a countdown**, not an open pool: the platform
picks one courier and pushes an offer with a ~30–45 second accept window, cascading to the next on
decline or timeout. The job is never simultaneously claimable, so there is no race to lose. Declining
is free but tracked — acceptance rate gates perks rather than triggering penalties. Capacity is
structural: a courier holds one delivery or batch at a time. Open pools do exist — Instacart's batch
list is genuinely first-come-first-served — and they produce exactly the wasted-effort race that the
directed model avoids, which is why they are the disliked shape.

**The one thing that is different for us: their offer is free to make and free to retract.** No money
moves at offer time. Here `createTask` locks USDC. An offer made after funding means a decline
strands funds until `expireTask` and the agent pays gas twice.

---

## Decision

### D1 — Directed offer, one live offer per task

The agent selects one worker and offers. On decline or expiry the agent re-targets.

**An agent may not hold simultaneous offers to several workers for the same task.** Fan-out
reinvents precisely the wasted-effort race the directed model exists to avoid — several workers
each decide to make themselves available, and all but one of those decisions is wasted. Cascade,
do not broadcast.

### D2 — The offer lives entirely off-chain, before funding

This follows from the difference identified above: money must not lock until a worker has agreed.

**The gap already exists.** `request_human_work` creates a `pending` DB row and returns funding
instructions; `createTask` happens later. `pending` **is** the offer state. Acceptance slots into the
space that is already there.

```
request_human_work → pending (offer, with expiry)
   ├─ worker accepts / auto-accepts  → accepted
   ├─ worker declines                → agent re-targets
   └─ offer expires                  → agent re-targets
accepted → agent calls createTask   → active (funds locked)
```

**No contract change and no new on-chain state.** The chain is not involved in matching and should
not be — an on-chain offer would lock money at offer time, cost gas per decline, and require a
contract state that does not exist.

Note this makes the existing `VALID_TRANSITIONS` map (`src/lib/db/tasks.ts:78`) incomplete rather
than wrong: `pending → active` stays, with `accepted` inserted between.

### D3 — `accepts_auto_booking` becomes enforcement, not metadata

- **True** → the offer auto-accepts. The worker has pre-authorised being booked against their own
  stated categories and rate.
- **False** (default) → the offer waits for the worker, and lapses at expiry if they do not answer.

This is the change that makes the `/learn` module 5 claim true rather than aspirational. It is also
the point of `CC-074`, which is currently written as a dashboard toggle — a toggle over a field
nothing reads.

### D4 — Offer expiry is agent-set within app-enforced bounds

Mirrors the `reviewWindow` precedent from `CC-082` — agent-set, bounded — except the bound is
app-side, because the offer is off-chain.

Delivery platforms use 30–45 seconds because couriers are mid-shift inside an app. Our workers are
not: the target user is someone who checks a phone between other work. So the range is
minutes-to-days, not seconds. **Bounds: 15 minutes to 7 days.** The default is an open item.

Both bounds carry weight. The lower stops an agent issuing an offer that is unanswerable in
practice and then claiming the worker was unresponsive. The upper stops an agent parking a worker's
availability indefinitely at no cost — the offer is free, so without a ceiling it is a free option
on someone else's time.

### D5 — Concurrency cap on accepted and active tasks per worker

A cap on `accepted` + `active` tasks a single worker may hold. Structural, in the same way a courier
holds one delivery at a time — not advisory, and not a reputation input.

Rationale is the worker's, not the platform's: a worker who has accepted eight jobs for the same
afternoon will fail most of them, and under `ADR-0001` D1 each failure is a delivery deadline that
passes and refunds the agent. The cap prevents a self-inflicted `CC-075` cascade.

Starting value is an open item. It should be worker-adjustable eventually; it should not start
unbounded.

### D6 — Declining is free and carries no reputational penalty in v1

DoorDash's acceptance-rate mechanism is a scale lever — it exists to keep a large fleet responsive.
We have no scale, and penalising declines before there is volume punishes the honest *"I'm not free
today"*, which is exactly the answer the system needs to hear. Revisit when there is volume to
measure.

**This sharpens `CC-075`.** A worker who declines is participating. A worker who is silent until
offers lapse is the AWOL signal — and it is a **better** signal than the one `CC-075` currently
proposes:

| Signal | Cost to detect | Latency |
| :-- | :-- | :-- |
| `CC-075` today: N consecutive `TaskExpired` with no `WorkSubmitted` | An agent's USDC locked for a full deadline, three times | Days to weeks |
| Lapsed offers | Nothing. No escrow, no chain, no gas | Hours |

Lapsed offers cost nobody anything to observe, and they catch the AWOL worker *before* an agent's
money is committed rather than after. `CC-075`'s expiry-based signal remains valid as a backstop for
a worker who accepts and then vanishes, which lapsed offers cannot see.

### D7 — Notification delivery is a dependency of the offer, not a nicety

An offer nobody is told about is an expiry with extra steps. The two ship together, or the offer
mechanism is worse than what exists now — because today a worker at least is not being silently
timed against a clock they cannot see.

This promotes "no notification delivery exists" from a gap to a blocker, and it is why `CC-095`
blocks `CC-094` rather than sitting alongside it.

---

## Rejected alternatives

| Rejected | Why |
| :-- | :-- |
| Open pool, first claim wins | Produces the wasted-effort race directly; invites sniping and bots (the Instacart shape) |
| Directed first, pool as fallback | Two matching paths to build, monitor and explain, for a coverage problem we do not yet have |
| Simultaneous offers to several workers | Reinvents the race inside the directed model (D1) |
| Offers on-chain | Locks money at offer time, costs gas per decline, needs contract state that does not exist |
| Acceptance-rate penalties in v1 | A scale lever with no scale; punishes the honest decline (D6) |
| Worker-set intake rules per category | **Deferred, not rejected.** The most faithful answer to "I'm free this afternoon", but it needs `CC-073`/`CC-074`'s dashboard work first |

---

## Consequences

- **`CC-074` changes shape.** It is currently a dashboard toggle; it becomes the toggle *plus* the
  enforcement that makes the toggle mean something. Without D3 the toggle is decoration.
- **`CC-075` gains a cheaper, earlier signal** and keeps its existing one as a backstop (D6).
- **`CC-084` gains the moment it was missing.** `ADR-0001` D3 requires the spec be shown to the
  worker "before they accept", and until now there was no acceptance to be before. The spec displays
  at the offer, and accepting is what the phrase refers to. `ADR-0001` Amendment 2 A2.1's
  requirement — that the criteria render human-readably rather than as JSON — attaches here.
- **`/learn` module 5 and the `x402.ts` instructions string become true.** Both currently describe
  this mechanism as though it exists. Neither needs rewriting if this ships; both need `CC-014`
  checklist entries until it does.
- **A new task state, `accepted`, between `pending` and `active`**, plus terminal `declined` and
  `lapsed` for offers that never became tasks. `VALID_TRANSITIONS` and migration `009`'s
  immutability trigger both need to know about them.
- **The concurrency cap needs a live counter**, which is the first thing in this design that cannot
  be derived from the chain. It is derivable from the DB alone, so it does not violate `ADR-0002`
  D5 — but it is worth noting that an offer is the one part of the lifecycle with no on-chain shadow
  at all.
- **Nothing here is a fund-safety change.** No contract change, no new custody surface, no change to
  who can move money. This is entirely a matching-layer decision.

---

## Open items

- **Offer expiry default** within the 15m–7d bounds. Wants a real distribution of worker response
  times, which does not exist yet; pick a conservative default and revisit.
- **Concurrency cap starting value**, and whether it varies by category (a photo errand and a
  multi-day job do not occupy the same amount of a person).
- **Whether an agent may re-offer to a worker who declined the same task.** Once is a mis-target;
  repeatedly is harassment with extra steps.
- **What a worker sees for a task they declined.** Probably nothing, but "probably" is not a
  decision.
- **Whether `availability` on `humans` should gate offers** (`available`/`busy`/`offline`).
  It is currently self-reported and never read by the hire path. Related to `CC-021`.

---

## Handover — implementation order

1. **`CC-095` — notification delivery.** D7 makes this first. An offer with no delivery is worse
   than no offer.
2. **`CC-094` — the offer lifecycle**: `accepted`/`declined`/`lapsed` states, expiry bounds (D4),
   `accepts_auto_booking` enforcement (D3), one-live-offer-per-task (D1), concurrency cap (D5).
3. **`CC-074`** — the dashboard toggle, now over a field that is actually read.
4. **`CC-084` PR 2** — the worker-facing spec display at the offer, with `CC-093`'s auth fix.
5. **`CC-075`** — switch the AWOL signal to lapsed offers, keeping expiries as the backstop.
6. **Copy** — `/learn` module 5 and `x402.ts`'s instructions string verified against the built
   behaviour rather than left as forward-looking.

Related: `CC-093`, `CC-094`, `CC-095`, `CC-074`, `CC-075`, `CC-084`, `CC-021`, `CC-014`,
`ADR-0001` D1/D3 + Amendment 2, `ADR-0002` D5.
