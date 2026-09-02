# Backlog convention

Issue tracking lives in this folder as plain markdown, versioned with the code. It replaced
Linear in July 2026. No server, no account, no API — `grep` and `git log` are the query language.

- **[INDEX.md](INDEX.md)** — generated board view. Never edit it by hand.
- **`CC-###.md`** — one file per issue. These are the source of truth.

## File format

Every issue file starts with a frontmatter block, then a `# CC-### — Title` heading, then free
markdown. Keep the body structured as Problem / Fix / Acceptance where it makes sense.

```markdown
---
id: CC-042
title: Short imperative summary
status: todo
priority: P1
area: frontend
epic: public-launch
linear: NOR-183          # optional — original Linear id, if migrated
created: 2026-07-25
updated: 2026-07-25
---

# CC-042 — Short imperative summary

## Problem
What is wrong, with `file.ts:123` references so it can be found again in six months.

## Fix
What to do about it.

## Acceptance
How we know it is done.
```

### Field values

| Field | Allowed |
| :-- | :-- |
| `status` | `todo`, `in-progress`, `blocked`, `done`, `wontfix` |
| `priority` | `P0` (blocks launch), `P1` (needed soon), `P2` (should fix), `P3` (nice to have) |
| `area` | `frontend`, `backend`, `contracts`, `security`, `infra`, `content`, `testing`, `docs`, `cleanup`, `process`, `compliance` |
| `epic` | `public-launch`, `mainnet`, `mcp-package`, `process` |

`title` must stay on one line — the frontmatter parser is deliberately simple and does not
handle multi-line or quoted YAML values.

## Workflow

Regenerate the board after any change:

```bash
node scripts/backlog.mjs           # rewrite INDEX.md
node scripts/backlog.mjs --check   # exit 1 if stale — for CI
```

The script has no dependencies and runs before `npm install`. It validates every file as it
goes and fails loudly on a bad status, priority or missing field, so a malformed issue cannot
sit around unnoticed.

Closing an issue means setting `status: done`, bumping `updated`, and adding a short note at
the bottom of the file recording what was actually done and in which commit. Do not delete
issue files — the history is the point. Use `wontfix` with a stated reason for things that are
deliberately not being done.

Reference issue ids in commit messages (`fix(connect): show wallet button on mobile (CC-001)`)
so `git log --grep=CC-001` reconstructs the story.

## Linear as the live work-tracking layer

As of 2026-09-02, multiple workers touch this repo at once — Aaron directly, Claude Code sessions,
and a Hermes agent, with more workers (human or agent) anticipated if things go well. Splitting
"what we're building" from "who's doing what right now" avoids every worker contending for edit
rights on the same `CC-###.md` file:

- **The repo (`CC-###.md`) stays the stable definition of the goal.** Problem, fix, acceptance
  criteria — the thing a worker checks their output against. Low churn, gated by the
  tracked-work-items rule (`CLAUDE.md`), because it is the shared record everyone re-derives from.
- **Linear (North Metro Tech workspace) is the churn layer.** A `CC-###` item that needs breaking
  into actionable pieces gets a Linear **hub issue** (mirrors the `CC-076`/`CC-039` hub pattern:
  not itself actionable, exists to parent sub-issues) plus as many sub-issues as the work actually
  needs, added or closed freely without touching the repo file. This is where day-to-day pickup,
  assignment and status live.
- **Every Linear issue must name its `CC-###` parent** in its description (`Related: CC-###`), not
  just the Linear hub — a worker pulling from Linear has to be able to find the repo definition of
  "done" without already knowing the mapping.
- **Tier with the existing `L1`/`L2`/`L3` labels** so work routes to the right worker: `L1` direct
  to a Hermes Coder (small, bounded, low-risk), `L2` to Hermes Kanban (multi-step, dependencies,
  review coordination), `L3` escalates to Claude Code (difficult, unfamiliar, security-sensitive —
  this includes anything touching the auth/trust boundary, not just contract code).
- **The repo file gets a Linear provenance table**, refreshed periodically (same shape as the
  existing "Linear provenance" section in `INDEX.md`, or `CC-099`'s own closing note) — not kept
  live in sync item-by-item, since Linear will always move faster than a file gated by explicit
  approval. Treat a stale provenance table as expected, not a defect; refresh it at a natural
  checkpoint (a hub issue closing out, a milestone, a status check-in), not on every Linear edit.

This does not change the tracked-work-items rule itself — creating or editing a `CC-###.md` file
still needs your explicit go-ahead. It changes what has to go through that gate: the stable
definition does, the day-to-day breakdown of it does not.

## Numbering

`CC-###`, allocated sequentially, never reused.

**Check the directory for the next free number — there is no allocator.** Two branches cut at
different times cannot see each other's choices, and on 2026-08-16 three ids collided in one day
(`CC-092`, then `CC-096` twice). Each renumber touched 20+ references across a dozen files.

Two guards now exist, covering different halves:

- **`backlog.mjs` asserts the filename matches the frontmatter `id`.** The filesystem stops two
  issues sharing a name, so a duplicate can only enter as a mismatch — which is what a half-finished
  renumber leaves behind.
- **`scripts/check-issue-ids.mjs` fails CI when two *open* PRs add the same id.** Git only sees that
  as an add/add conflict once one of them merges, by which point the id is already threaded through
  commit messages and cross-references. Both PRs go red, deliberately: which one moves is a
  judgement call (first claim usually wins), not a script's decision.

If you are renumbering, `git grep -n CC-0XX` before pushing — the id appears in code comments and
other issues' `Related:` lines, not just the issue file.

- `CC-001` to `CC-038` — seeded 2026-07-25 from the codebase review, `AUDIT-2026-03-25.md`, the
  MVP definition of done, and the `NOR-` references still in the code.
- `CC-039` to `CC-054` — added the same day from the full Linear export, plus findings that came
  out of reconciling it against the code.

Issues migrated from Linear carry their original id in the `linear:` field so old commit messages
and code comments referencing `NOR-xxx` remain traceable.

## Provenance

Linear (team North Metro Tech, project Carbon-Contractors) was retired in July 2026. Two archives
preserve what was there:

- **[carbon_contractors_full_export.md](../carbon_contractors_full_export.md)** — all 37 issues
  (24 done, 2 cancelled, 2 todo, 9 backlog). The 24 done and 2 cancelled issues live only here;
  they were deliberately not recreated as `status: done` files. Issue **comments were not
  captured** by the export.
- **[Linear-Document-Archive.md](../Linear-Document-Archive.md)** — the four project documents:
  architecture overview, MVP definition of done, security and trust disclosure, and the HSM
  deployer checklist.
