# Continuity register

The asset map `ADR-0006` D5 calls for: per asset, **what it is, who can reach it, what it costs, when
it renews, and what breaks first if it lapses.**

Written for a stranger, not for Aaron. **No credentials — only the map.** Nothing here may depend on
a private workspace, which is the flaw in the DR plan that currently lives only in a Claude project.

> **Status: seeded, not complete.** `ADR-0006` is `proposed`, not accepted. This file exists early
> because two of its assets — the ENS names — were registered on 2026-08-25/26 and their renewal
> dates are already running. Everything D5 names that is not below is listed under
> *[Not yet recorded](#not-yet-recorded)* rather than left to be inferred from silence.

---

## Naming and discoverability

### `carbon-contractors.base.eth` — Basename, on Base

| | |
| :-- | :-- |
| **What it is** | The project's on-chain identity, on the same chain as the escrow and USDC. |
| **What uses it** | Displayed in the site footer and the coming-soon page, linking to `base.org/name/carbon-contractors`. Intended as the `ADR-0006` D6 machine-readable pointer — an ENS name carrying a `url` text record, resolved at runtime by an MCP client instead of a hard-coded URL. |
| **Who can reach it** | **TO FILL** — the controlling wallet address, and whether that key is covered by the succession arrangement in `ADR-0006` D1–D4. |
| **Cost / renewal** | **TO FILL** — Basenames renew annually. Record the expiry and whether auto-renew is configured. |
| **What breaks first if it lapses** | Today: the footer link 404s. Cosmetic. **Once D6 is implemented, this becomes the worst asset on this page to lose** — agents resolve it automatically, so a new owner silently becomes the canonical pointer for the platform, with no human in the loop to notice the handover. |

**Basenames are ENS**, deployed on Base under the `base.eth` namespace. D6's "an ENS name" is
satisfied by this one; it does not require the L1 registration below. An agent that cannot reach Base
cannot use this platform anyway, so resolving the pointer on Base costs no availability — D6 is about
the *front door* being unreachable (Vercel, DNS), not the chain.

### `carbon-contractors.eth` — ENS, L1 mainnet

| | |
| :-- | :-- |
| **What it is** | A **defensive registration**, held to stop typo- and name-squatting. |
| **What uses it** | **Nothing, deliberately.** It is not the D6 pointer and should not become one. |
| **Who can reach it** | **TO FILL** — controlling wallet, and whether it is the same key as the Basename. |
| **Cost / renewal** | 0.0040 ETH (~$10.01) for 2 years. **Expires 25 August 2028.** Auto-renew status **TO FILL**. |
| **What breaks first if it lapses** | Nothing technical — and that is the trap. A defensive name that lapses hands someone the exact squat it was bought to prevent, and it is the easiest asset here to forget precisely because nothing depends on it. Three-year gap to the next action, no operational signal in between. |

**Keep it inert.** The temptation is to put a `url` text record on it "for completeness". Don't:
two pointers drift, and the one nobody checks is the one that goes stale. Either leave it unset, or
if it is ever given a record, that record must be generated from the same source as the Basename's
rather than maintained separately.

### Renewal is the shared hazard

Both names expire, and neither failure is loud. Whatever calendar or monitor covers the domain
registration should cover these on the same footing. `ADR-0003`'s argument for the monitor heartbeat
applies exactly: an expiry that passes silently is indistinguishable from everything being fine.

---

## Not yet recorded

`ADR-0006` D5 names these, and none is captured yet. Listed so the gap is visible rather than
implied:

- **Domain and registrar** — `carbon-contractors.com`, plus the apex → `www` redirect observed in
  production on 2026-08-26. Registrar must sit outside the hosting provider, with auto-renew,
  registrar lock, and a recovery contact that is **not** an address on the domain being recovered.
- **DNS** — Cloudflare, per the existing DR plan. D6 asks for this to be confirmed and recorded, not
  assumed: it is what lets the site be repointed without the host being reachable.
- **Vercel** — hosting, plan tier (`CC-063`), and who holds the account.
- **Supabase** — database, tier and pause behaviour (`CC-058`), backup posture (`ADR-0006` D8).
- **GCP / Cloud KMS** — the HSM key that owns the escrow (`CC-059`). The highest-consequence entry
  on this list and the one most tightly bound to `ADR-0006` D1–D4.
- **GitHub org** — `carbon-contractors`, including who can administer the rulesets that require
  signed commits and code scanning.
- **npm org** — for the standalone MCP package (`CC-044`), if and when it is published.

Also outstanding from D7, and not started: `chain-constants.json`, the re-host runbook, and the
protocol reimplementation spec.

---

Related: `ADR-0006` D5/D6/D7, `CC-091`, `docs/Infrastructure decentralization & DR plan.md`,
`docs/Key-Compromise-Recovery.md`.
