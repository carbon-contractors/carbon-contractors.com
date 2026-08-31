# Continuity register

The asset map `ADR-0006` D5 calls for: per asset, **what it is, who can reach it, what it costs, when
it renews, and what breaks first if it lapses.**

Written for a stranger, not for Aaron. **No credentials — only the map.** Nothing here may depend on
a private workspace, which is the flaw in the DR plan that currently lives only in a Claude project.

> **Status: partial, and honest about which parts.** `ADR-0006` was **accepted 2026-08-26**, which
> makes this file a D5/D7 deliverable rather than an anticipation of one. The naming, chain-constant,
> backup and ownership sections below are current. Everything D5 names that is *not* covered is listed
> under *[Not yet recorded](#not-yet-recorded)* rather than left to be inferred from silence — an
> asset register whose gaps are invisible is worse than none, because it reads as complete.

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

## Chain constants

**`chain-constants.json`, in the repository root** — `ADR-0006` D7's first deliverable, added
2026-08-26. Per network: escrow address and deploy block, USDC, owner and custody model, accepted
verdict signers, RPC block-range limit; and network-independent, the EIP-712 domain, the verdict
typehash, the review-window bounds, the checker hash, the canary digest, the supported spec versions
and the retention rule version.

These values previously existed only scattered across `.env.example`, `CLAUDE.md` hazard notes and
ticket bodies, which is also why they kept going stale — five wrong claims were found in `CLAUDE.md`
in a single audit on 2026-08-13.

**It is a record, not an authority.** Every network block carries the audit script that re-derives
it, and the standing rule holds: if the file and the chain disagree, the chain is right and the file
is a bug. Two fields are deliberately `false`/`null` rather than omitted — `verdictSignerSeparation`
and the mainnet block — because an absent field reads as "fine".

---

## Contract ownership

| | |
| :-- | :-- |
| **What it is today** | A single GCP Cloud KMS / HSM key, `0xa893…3e4b`, which owns `CarbonEscrow` **and** is its only accepted verdict signer. |
| **What it becomes** | A **2-of-4 Safe** over four **independently initialised** hardware keys, with the verdict signer separated onto its own HSM key. `ADR-0006` D2, accepted 2026-08-26. Lands before the mainnet deploy (`CC-034`), tracked by `CC-090`. |
| **Procurement** | Four Tangem cards ordered **2026-08-31**, ~A$130 total, shipping from the US, **expected ~2026-09-17**. Supplied as multi-card packs rather than four separate single-card orders — see the failure mode below, which this changes. |
| **Who can reach it** | **Aaron: two keys, in two separate buildings. Two family members: one key each.** Roles only — locations are deliberately **not** recorded here, see below. The two family keys reach threshold alone, which is what makes succession work. |
| **What breaks first if it is lost** | Arbitration only. Funds are not stranded: `ADR-0001` A1.2 made every settlement path a pull payment the parties claim themselves, and D3's arbitration clock (accepted, not yet built) will default an unresolved dispute to the worker. The owner key cannot move money to any address other than the two fixed at funding (`ADR-0001` D9). |

**Locations are not in this file, on purpose.** The repository is public (`CC-056`). Recording which
building holds which card would publish a burglary map for a wallet with arbitration authority over
live escrow. Locations belong with the estate documents; this register carries roles and separation.

**The failure mode to design against is a multisig that is not one.** A multisig built over cards
that share a seed has the security of a 1-of-1 while looking like a real multisig on Basescan.

**This section changed on 2026-08-31 and the change matters.** It previously said the cards were
bought separately, "so a shared seed is impossible by construction." They were not — they were bought
as multi-card packs. So:

- **The property was never the purchase.** It is **independent initialisation**. Purchase structure
  was a proxy for it, chosen because it was checkable at order time, and that proxy is now gone.
- **The vendor's account** is that cards in a pack become linked only when the second is registered
  as a backup through the app, and that skipping that step leaves each card an independent wallet.
  Plausible, and consistent with how the hardware works, but **vendor-reported and unverified by
  us.** It is now a setup *procedure* to execute correctly rather than a fact about the boxes.
- **The test moved earlier and got cheaper.** Four distinct addresses can be read straight off the
  four cards, before a Safe exists and before any transaction: tap each, read its address. That is
  the first gate, on day one of delivery. The on-chain four-owner check stays as the final gate,
  because the Safe's owner set is what actually enforces the threshold.
- **Getting it wrong is recoverable, but only for a while.** A Tangem card can be factory-reset, so a
  mis-initialised pair can be redone — up until the cards are distributed to their holders and the
  Safe is funded. Confirm the reset procedure against Tangem's own documentation before relying on
  it; this file is not the authority on their hardware.

### Slot assignment — a free hedge, and it cannot be applied retroactively

Assign cards to slots so that **no two cards from the same pack land in either load-bearing pair.**

| Slot | Holder | Take the card from |
| :-- | :-- | :-- |
| 1 | Aaron — daily driver | pack A |
| 2 | Aaron — secured, different building | pack B |
| 3 | Family member A | pack A |
| 4 | Family member B | pack B |

The two pairs that carry the arrangement are **Aaron's own two** (day-to-day operation, no
coordination needed) and **family A + family B** (the succession path, D2's whole reason for 2-of-4).
Under this assignment both pairs cross packs.

Why do it either way: if initialisation worked, pack membership is meaningless and the assignment
costs nothing. If it silently did not, the two pairs that matter still reach threshold, and what
degrades is loss tolerance — you could no longer lose both cards of one pack — rather than
succession. **The wrong assignment fails in exactly the case 2-of-4 was chosen to cover:** two family
cards from one pack are one signer, and can never reach threshold together.

Do the four-address check **before** distributing, because after distribution the cards are in
different buildings and in non-technical hands.

**Why 2-of-4 and what it buys.** It tolerates losing any two keys; Aaron can still act alone holding
two; and critically **the two family keys reach threshold without him**, so succession does not depend
on an estate locating and recognising one of Aaron's cards. Losing three of four is the only failure.

**What is left is human, and it sits exactly on the succession path.** Both family holders are
non-technical and they are the two who must act together if Aaron is gone:

- **A 2-of-4 signature by the two family keys alone**, rehearsed on testnet, is a `CC-090` closing
  condition. Not one that merely includes them — the succession path is family-only, so that is the
  path to prove.
- **An estate packet** held with the will: that the keys exist, what a Tangem card looks like, what it
  controls, who the other holders are, how to reach the signing flow. The likeliest failure is not
  that nobody finds a card, it is that somebody finds one and throws it out.

**Slots 3 and 4 are transitional.** `ADR-0006` D11 rotates them to partners or a professional
key-holder service on measured-adoption triggers; the threshold stays 2-of-4 and the Safe is never
rebuilt. Rotate while the outgoing holder is still reachable — the swap is itself a 2-of-4
transaction.

### Custody escalation triggers (`ADR-0006` D11)

Keyed to the limbs `verify-concurrent-escrow.mjs` already measures — the AU Digital Assets Framework
small-scale exemption ($5,000 peak concurrent per agent, $10m trailing-365-day volume, commencing
2027-04-09, `CC-051`).

| | Rotate | Any one of | Sustained |
| :-- | :-- | :-- | :-- |
| **Tier 1** | one family slot → professional key-holder service | aggregate peak escrow ≥ $25,000 · 365-day volume ≥ $250,000 · ≥ 50 workers with funds in flight | 30 days |
| **Tier 2** | second family slot → partner | 365-day volume ≥ $1,000,000 · aggregate peak escrow ≥ $100,000 | 90 days |

**Volume-independent backstops:** Tier 1 also fires on **2027-04-09** if the platform is live and not
clearly exempt; and either family key going **12 months untested** is its own escalation, because
under 2-of-4 those two keys *are* the succession path.

These are governance triggers, not invariants — the monitor warns, it must not fail. A monitor that
goes red on commercial success teaches its reader to ignore it.

---

## Data and backups

**`ADR-0006` D8, accepted 2026-08-26: backups hold registration data; task content and evidence are
never in a backed-up store.**

The reason is that `src/legal/privacy.md` and `/learn` module 7 promise deletion, and a deletion
guarantee is only true if a restore cannot resurrect what retention removed. `ADR-0002` D9 lists
backups as one of three traps that would make the claim false; D8 turns that caution into the rule.

- **Backed up:** the `humans` registry, `notification_channels`, and the task *metadata* that is
  either already on-chain or non-sensitive.
- **Not backed up, deliberately:** `task_description`, `acceptance_spec`, and anything else the
  `CC-087` retention engine prunes. The accepted cost is that **task content has no restore path.**
  That is the intended trade — the alternative is a backup that silently un-deletes.
- **Nothing implements this yet.** D8 is a requirement; the Supabase backup configuration that
  satisfies it is unbuilt, and a backup configured wrong is indistinguishable from one configured
  right until somebody restores. That belongs with the D8 restore test.

Retention itself now runs: `/api/cron/retention` fires daily at 03:17 UTC (`CC-087`, PR #147).

---

## Product and task tracking

| | |
| :-- | :-- |
| **What it is** | **Linear**, reinstated 2026-08-30 as the canonical product/task layer for the *Allogaia* operating model (ADR-015, Allogaia). The shared "North Metro Tech" workspace carries both Allogaia and Carbon Contractors work. |
| **What it is *not*** | The source of truth for this repo. `docs/backlog/`, the `CC-###` ids and `scripts/backlog.mjs` remain that, and are unaffected — the reinstatement is organisation-level. See the dated note at the end of `CLAUDE.md`. |
| **Who controls it** | Aaron, via the North Metro Tech workspace. |
| **Cost / renewal** | **TO FILL** — plan tier and billing cycle. Recorded as a gap because the previous Linear arrangement was abandoned in July 2026 *for cost*: the free plan was outgrown. That is a known failure mode for this dependency, not a hypothetical. |
| **What breaks first if it lapses** | Cross-org product context — sequencing, priorities, anything spanning Allogaia and Carbon Contractors. **This repo keeps working**, which is the mitigation and is worth being deliberate about: `docs/backlog/` is in git, is public, and survives any SaaS. The exposure is decisions and discussion that exist *only* in Linear and nowhere in the repo. |
| **Export posture** | **TO FILL** — whether anything Carbon-Contractors-specific lives only in Linear, and whether it is exported anywhere. A decision recorded in Linear and not in an ADR is a decision this repo cannot see. |

**The 2026-08-30 reinstatement is the second arrangement, not a return to the first.** The July 2026
retirement moved tracking into the repo, which is why `docs/backlog/` exists at all and why the
`linear:` frontmatter field maps historical `NOR-###` ids. Those ids belong to the **old** workspace.
New Linear ids come from a different workspace and a different sequence, so an id encountered in
future work is not comparable to a `NOR-###` in a code comment.

**The standing rule is unchanged and this does not relax it.** An out-of-scope problem noticed during
work goes in a one-line *Observations* note; Aaron decides what becomes a `CC-###` — or now, what
becomes a Linear issue instead. Neither tracker changes who triages.

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
- **GCP / Cloud KMS** — the project, the key ring, and who can reach the console. The key's *address*
  and role are now in `chain-constants.json` and under *Contract ownership* above; what is missing is
  the account-level access map. Highest-consequence entry on this list.
- **GitHub org** — `carbon-contractors`, including who can administer the rulesets that require
  signed commits and code scanning.
- **npm org** — for the standalone MCP package (`CC-044`), if and when it is published.

Also outstanding from D7: the **re-host runbook** (clone, configure, deploy elsewhere, repoint,
announce) and the **protocol reimplementation spec** (tool schema, EIP-712 domain and typehash, state
machine, checker bundle format). `chain-constants.json` is done; the spec waits on `CC-092`'s surface
existing, which it now does.

The runbook is the one a stranger actually needs, and it is the one still missing. `chain-constants.json`
tells them *what* the values are; nothing yet tells them *what to do with them*.

---

Related: `ADR-0006` D5/D6/D7, `CC-091`, `docs/Infrastructure decentralization & DR plan.md`,
`docs/Key-Compromise-Recovery.md`.
