---
id: ADR-0003
title: Monitoring as a correctness dependency, not an ops nicety
status: accepted
date: 2026-08-13
deciders: Aaron Clifft
depends-on: ADR-0001 (D5 checker, D6 liveness, Amendment 1), ADR-0002 (D4 retention, D9 verifiable deletion)
resolves: CC-040 (rescopes and splits)
area: infra
epic: public-launch
---

# ADR-0003 — Monitoring as a correctness dependency

## Status

**Accepted**, 2026-08-13. Rescopes and splits `CC-040`.

---

## Context

`CC-040` was written on 2026-07-25, before `ADR-0001` and `ADR-0002`. Its framing — error alerting, uptime, on-chain event monitoring — is correct but incomplete, because at the time the worst case was downtime. Its own opening line is *"the site was up for four months unattended and the only reason that was survivable is that no real money was moving."*

The two ADRs changed what failure means. Monitoring is now load-bearing for **correctness**, not availability, because several new failure modes are **silent** — the system continues operating and produces wrong outcomes without erroring.

### The silent failures the ADRs introduced

- **Checker unavailability auto-releases funds.** `ADR-0001` D6: no valid failing verdict presented before the window closes → the worker can claim. If the checker crashes, times out, or cannot reach an agent's bucket, every task in flight becomes claimable regardless of evidence quality. Fraudulent submissions get paid. **Nothing errors** — the system does exactly what it is designed to do. This is the single highest-consequence gap in the design.
- **Verdict signing failure looks identical to a passing task.** Post-Amendment 1 the platform makes no transaction, so there is no failed transaction to alert on. The absence of a signature is the failure, and absence is not an event.
- **Unclaimed settlements look like theft.** Pull-payment (Amendment 1 A1.2) means funds sit in escrow until the worker claims. A worker who does not know to claim, or whose claim reverts, sees a completed job and no money. Correct behaviour, indistinguishable from a bug, and it will be reported as one.
- **Retention job failure publishes a false claim.** `ADR-0002` D4 backs statements in `README.md` and `/learn`. A silently failing deletion job does not degrade a feature; it makes a published privacy claim untrue, and `ADR-0002` D9 requires deletion be *verifiable*.
- **Commitment drift is undetectable by reading.** A DB row whose content no longer hashes to its on-chain commitment is provably corrupt — but only if something checks.

## Decision

### D1 — Split `CC-040` by what the alert protects

| Class | Protects | When |
| :---- | :---- | :---- |
| **Invariant monitoring** | correctness, fund safety, published claims | **before** `CC-077`/`078`/`079` |
| **Operational monitoring** | availability | day-of, as `CC-040` already says |

`CC-040`'s "day-before-launch, or you're just watching an empty coming-soon page" reasoning remains correct for the second class and **is wrong for the first**. The next work item is running the full funded lifecycle end to end on Sepolia. The invariant monitors are how you know that lifecycle actually worked. Building them afterwards means verifying the same properties twice — once by hand during the lifecycle tests, once again in code.

### D2 — Invariant monitors (build first)

Each is a script producing a non-zero exit on violation, runnable locally, in CI, and on a schedule. This mirrors the existing `verify-contract-owner.mjs` / `verify-escrow-solvency.mjs` pattern rather than introducing a new one.

| Monitor | Invariant | Violation means |
| :---- | :---- | :---- |
| `verify-escrow-solvency` (exists) | `USDC.balanceOf(escrow) == totalLocked` | funds stranded or unaccounted |
| `verify-commitments` (`ADR-0001` D4) | every DB row hashes to its on-chain commitment | DB corrupt or tampered |
| `verify-retention` (`ADR-0002` D9) | no task content persists past terminal state + window | published privacy claim is false |
| `verify-signer` | the verdict signer can produce a valid signature | settlement silently degrades to auto-release |
| `verify-checker` | canary evidence set yields the expected pass and fail verdicts | the checker is wrong, not merely down |
| `verify-unclaimed` | no claimable task older than N days | workers are not claiming; pull-payment UX broken |
| `verify-verdict-rate` | verdicts issued ÷ submissions, over a window | signing or checker pipeline failing silently |

**`verify-checker` is the one that does not exist in any conventional monitoring stack and matters most.** "The checker is running" is not the property that needs holding. The property is "the checker still returns the right answers" — so it runs a fixed canary set of evidence with known-correct verdicts through the real pipeline. A checker that is up and wrong is worse than one that is down, because down eventually fails loudly and wrong never does.

The canary set is committed to the repo, versioned with `checkerHash`, and is the same fixture the `ADR-0001` D5 re-runnability property depends on. One artefact, two purposes.

### D3 — Alert on absence, not just on error

The dominant failure mode post-Amendment 1 is *nothing happened*. Conventional error alerting cannot see this. Every invariant in D2 is therefore expressed as a **positive assertion checked on a schedule**, not as a handler waiting for an exception.

Practical consequence: the monitors must run and report success, so that silence from the monitor is itself an alert. A cron that stops running must be detectable.

### D4 — Runbooks are per-invariant, and the response is usually "pause"

`CC-040` already calls for a runbook per alert type. Post-ADR the correct first response to most invariant violations is not to debug — it is to **stop new task creation** while the money path is in an unknown state. Existing tasks resolve safely on their own clocks; new ones would not.

That implies a **kill switch on task creation** that is independent of the site being up, and it does not currently exist. It is a prerequisite for the runbooks having a first step.

Note this must not pause *claims* — halting settlement while tasks are in flight would strand funds and invert the whole `ADR-0001` D6 position. Pause intake, never disbursement.

### D5 — Near-zero cost, per the project's operating goal

The platform is intended to run at near-zero marginal cost and be self-sustaining. Monitoring must not be the line item that breaks that.

- **Scheduled GitHub Actions** run the invariant scripts. Free, already in the stack, alert logic lives in the repo where it is reviewable and version-controlled alongside the code it checks.
- **Webhook to Discord or Telegram** for alerting. No paid alerting vendor.
- **Sentry free tier** for application error alerting (`CC-040`'s original scope).
- **A free external uptime monitor** against `/api/health`, which already reports database, escrow and session health.
- **On-chain event monitoring via scheduled `getLogs`** over a block range. **Explicitly reject a paid indexer** at current volume — it is the obvious temptation and it is not yet warranted.

**Caveat, and the reason for two alerting paths:** scheduled GitHub Actions workflows are best-effort, can be delayed under load, and are disabled automatically after a period of repository inactivity. Acceptable for hourly invariant checks; **not acceptable as the only alerting path**. The external uptime monitor must be independent of GitHub so that at least one path survives GitHub being the thing that failed.

### D6 — Post-Amendment 1 scope reductions

Amendment 1 deleted monitoring obligations rather than adding them, which is worth recording so the scope is not reinstated from the older `CC-040` text:

- **No platform transaction monitoring in the settlement path** — the platform does not transact.
- **Deployer ETH balance alerting is moot** for settlement (already flagged in `CC-040` as dependent on `CC-033`); it remains relevant only for deployment and ownership operations.
- **"KMS signing failures" shrinks** from an on-chain failure monitor to `verify-signer`, a health check that the signer can produce a signature at all.

## Consequences

- **`CC-040` splits into two tickets.** The invariant half moves ahead of `CC-077`/`078`/`079` and is no longer a day-of task. The operational half keeps its existing P1/day-of framing.
- **A task-creation kill switch becomes a launch prerequisite** (D4). New work, not currently tracked.
- **The checker canary fixture becomes a required artefact** (D2), shared with `ADR-0001` D5.
- **`CC-051`'s threshold instrumentation** — peak concurrent USDC escrowed per funding agent, already noted in `CC-040` — fits the D2 pattern and should be built as an eighth monitor.
- **Monitoring is now on the critical path to the lifecycle tests**, which lengthens the run-up to launch. That is the correct trade: the alternative is running the money path for the first time with no instrument capable of telling you it went wrong.

## Open items

- Thresholds: `verify-unclaimed` age, `verify-verdict-rate` floor and window.
- Whether the kill switch is contract-level (pause `createTask`) or app-level (refuse `request_human_work`). Contract-level is stronger and survives an app compromise; app-level is reversible without a transaction. Probably both, at different tiers.
- Canary fixture: how many cases, and whether it includes evidence designed to fail each individual check independently.
- Alert routing — single channel initially, but `verify-escrow-solvency` and `verify-checker` warrant a path that wakes someone up.

## Handover — implementation order

1. **`verify-checker`** + canary fixture. Highest consequence, and required by `ADR-0001` D5 anyway.
2. **`verify-commitments`**, **`verify-retention`**, **`verify-signer`**.
3. **Scheduled workflow** running all invariant scripts, including the two that already exist; webhook alerting; success-reporting so monitor silence is detectable (D3).
4. **Kill switch** on task creation, plus the per-invariant runbooks that depend on it (D4).
5. **Run `CC-077`/`078`/`079`** — the full funded lifecycle, with monitors watching.
6. **Day-of, per original `CC-040`:** Sentry, external uptime monitor, on-chain event monitoring.

Related: `CC-040`, `CC-033`, `CC-039`, `CC-051`, `CC-058`, `CC-077`, `CC-078`, `CC-079`, `ADR-0001`, `ADR-0002`.
