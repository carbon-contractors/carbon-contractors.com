---
id: ADR-0015
title: The lapsed-task refund stays the agent's own call
status: proposed
date: 2026-10-19
deciders: Aaron Clifft
depends-on: ADR-0001 (A1.2 refunds are the agent's), ADR-0005 (lapse as re-targeting)
related: CC-119, CC-077, CC-080, CC-037, CC-051, NOR-333
area: backend
epic: public-launch
---

# ADR-0015 — The lapsed-task refund stays the agent's own call

## Context

`CC-119`: a Sepolia task funded 2026-09-01 passed its delivery deadline with nothing submitted.
`expireTask` is `Funded`-only, agent-only and past-deadline-only, and pays `task.agent` in the same
transaction. Nothing in the product could call it, so 1 USDC sat locked for six weeks.

Since then the dashboard has a Reclaim button (#256), and Aaron used it on 2026-10-13. The ticket
listed seven open questions. Items 5 (worker UX) and 7 (dead code) are engineering and are done.
Item 6 (monitor threshold) waits on a baseline. This ADR answers items 1–4.

One finding changed item 4. The ticket recorded the DB row as "still `active`" after the refund.
It was, at the time it was checked. `settlement-sync` runs hourly at `:23`, and the row went
`expired` at 09:23 UTC that day, which was that cron's next run. The sync works. What was observed
was up to an hour of lag, not a missing path.

## Decision

**D1 — Surface: the dashboard and MCP, both agent-signed.** The dashboard button stays.
`get_task_status` now returns a `reclaim` object when the chain reads `Funded` past the deadline. It
gives the escrow address, the `expireTask(bytes32)` selector, the task id and the only address that
can send it. An agent with no UI learns of the lapse on its next status poll, and has everything
needed to sign. The platform builds no calldata it would sign itself, and gets no write path.

**D2 — No contract change.** `expireTask` stays agent-only. A permissionless trigger would let the
platform or a keeper refund on the agent's behalf without custody, because the destination is fixed
at `task.agent`. It would still put a platform-initiated transfer back into the settlement path.
`CC-051`, the regulatory claims audit (NOR-537) and the lawyer brief (`CC-098`) all rest on that path
being empty. The agent is also the only party harmed by waiting, so making the agent act costs
nobody else anything. Revisit only if counsel says a platform-triggered, destination-fixed refund
does not change the classification. That would need a redeploy anyway, so it would ride `CC-034`.

**D3 — Notification: none stored for the agent.** Agents have no notification address on file, and
`ADR-0002` and `ADR-0004` limit what may be added. An agent learns of a lapse by polling
`get_task_status`, the same tool it already uses for every other state change. A push channel for
agents is a separate feature. If one is built it should cover every agent-relevant state change,
not just this one.

**D4 — DB state: unchanged until the chain moves.** No `expired-pending` status. Between the deadline
and the agent's `expireTask`, the row stays `active`. Every surface that decides what someone may
*do* (dashboard buttons, the MCP `reclaim` hint) reads the chain, not the row (`CC-037`). After the
refund, `settlement-sync` moves the row to `expired` within the hour. That lag is accepted. A
read-through write on `GET /api/tasks` was considered and rejected: it would put a DB write on a
public read path, to shave a delay off a status nobody acts on.

## Consequences

- `CC-119`'s "agent can reclaim without a human or a script" box is met by D1 over MCP.
- `CC-119`'s "DB status matches the chain" box is met, with up to an hour of lag. It was observed on
  the live task.
- `expireTaskOnChain` is removed from `signer.ts`. It could never succeed from the platform signer,
  and D2 says it never should.
- Item 6 (monitor) stays open on `CC-119`.
