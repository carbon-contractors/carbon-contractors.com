# CC-098 — Lawyer instruction brief: AUSTRAC AML/CTF Tranche 2 classification of Carbon Contractors

Prepared 2026-09-16. **Revised 2026-10-12** to correct four statements found wrong or overstated by
the NOR-537 code audit (`docs/audits/2026-10-regulatory-claims-audit.md`): signer/owner separation,
the fixed-destination claim as it applies to `ReputationStake`, what verdicts verify, and
`completeTaskByOwner` deployment status. This is an instruction brief for an Australian lawyer with AML/CTF (AUSTRAC)
practice. It is written to be self-contained: every platform fact is stated here with its
in-repo source, so counsel does not need repo access to reason about the architecture.

**Not legal advice.** Everything below is engineering/regulatory research by the platform
operator's own team, scoped so counsel can be asked sharp questions instead of vague ones.
All AUSTRAC citations were retrieved 2026-09-16 from the pages linked inline.

---

## 1. What we are instructing you to determine

Carbon Contractors is an unfinished, pre-launch platform. Before it moves from testnet to
mainnet — before any real USDC moves — we need a written position on whether operating it
would constitute providing one or more **registrable virtual asset designated services** under
the *Anti-Money Laundering and Counter-Terrorism Financing Act 2006* (Cth) as amended by the
AML/CTF Tranche 2 reform, and if so, precisely which obligations attach and in what sequence.

The urgency is real: the reform's transitional windows have already closed (see §3), so if the
platform is in scope, **registration must be applied for and approved before the service is
provided** — AUSTRAC may take up to 90 days to decide. Our mainnet launch gate (`CC-039`) is
explicitly blocked on this classification.

## 2. Who we are and what the platform does (verified facts)

The operator is a sole Australian-resident individual (no corporate entity yet; company
formation is planned but not done). The platform, "Carbon Contractors", is a two-sided
microtask marketplace where **AI agents hire human workers** and pay them in USDC (a
stablecoin) on Base, an Ethereum L2. It is built and deployed but **not launched**: the entire
site sits behind a "coming soon" gate (`CC-014`), and no member of the public has ever funded
or been paid through it.

Mechanics relevant to the classification question — all verified against the current smart
contract (`contracts/CarbonEscrow.sol`, v2) and audit record:

1. **Escrow, not custody, by design.** A hiring agent locks USDC in an on-chain escrow
   contract by calling `createTask` itself, from the agent's own wallet, naming the worker's
   payout address at funding time (`CarbonEscrow.sol:282`). The platform never touches the
   funds: there is no platform deposit address, and the API's role is only to confirm the
   on-chain state ("confirmation endpoint", `src/app/api/fund-task/route.ts`, fixed under
   `CC-081` Defect 1).
2. **Destinations are fixed at funding, by bytecode.** Every settlement path pays either
   `task.worker` or refunds `task.agent` — the two addresses recorded on-chain when the task
   was funded. In `CarbonEscrow` no function, including the owner's, can direct funds to any
   other destination (`ADR-0001` D9; verified by the `CC-037` trust-boundary audit and
   re-checked by source review in NOR-537). The contract has no sweep, rescue, `receive`,
   proxy, pause, `delegatecall` or `selfdestruct`. **This statement is scoped to the escrow
   contract only — see item 3a for the separate staking contract, which does not have this
   property.**
3. **The platform holds two privileged roles: dispute resolution and verdict signing.**
   The contract owner (a non-exportable key in Google Cloud's HSM, attestation published
   in-repo) can, in a *disputed* task only, choose which of the two fixed addresses receives
   the funds (`resolveDispute`, `onlyOwner`, `CarbonEscrow.sol:540`), and can force payment
   to the worker from the `Funded` or `Delivered` state (`completeTaskByOwner`,
   `CarbonEscrow.sol:397`) without any evidence check. The owner can also add or remove
   accepted verdict signers (`setVerdictSigner`, `:630`). A dispute requires a party to
   present a cryptographically signed *failing* verdict from an accepted verdict signer
   (`CarbonEscrow.sol:474`); the checker that produces verdicts is published and re-runnable
   (`ADR-0001` D2/D5). An arbitration clock binds the owner: past a 7-day window,
   `resolveDispute` reverts and the worker is paid (`ADR-0006` D3).
   - **Today the owner key and the verdict-signer key are the same key** (Base Sepolia;
     `chain-constants.json` `verdictSignerSeparation.separated: false`). The platform
     therefore controls both the gate into a dispute and the ruling on it. Separating them,
     and moving ownership to a 2-of-4 Safe, is required before mainnet (`ADR-0006` D2,
     `CC-090`) but is **not yet done**. An earlier draft of this brief called the signer
     "separate"; that was wrong for the current deployment.
   - **What the platform could do with those keys, bounded by the fixed destinations:** pay
     the named worker of any delivered task, or refund the named agent of a disputed task.
     It cannot send escrowed USDC to a third address. Because any address may fund a task,
     a platform-controlled agent wallet could in principle obtain a failing verdict and win
     its own dispute against a worker; this is a conflict-of-interest risk, not a custody
     capability, and is mitigated only by key separation and the Safe.
   - **`completeTaskByOwner` deployment status is unconfirmed.** It was added to the source
     on 2026-09-16, after the current Base Sepolia escrow was deployed (2026-09-01). Treat
     it as part of the intended mainnet design, not as a verified feature of the testnet
     deployment, until `scripts/audit/verify-escrow-deployment.mjs` confirms the selector.
3a. **A second contract, `ReputationStake`, does move funds to the platform.** Workers may
   stake USDC (minimum 20) as a trust signal. The owner can `slash(worker, amount)`
   (`contracts/ReputationStake.sol:123`), which transfers the slashed USDC **to the owner
   address**, at the owner's sole discretion and with no on-chain link to a dispute outcome.
   Unstaking is by the worker after a 7-day cooldown. This contract is deployed on Base
   Sepolia, has no automated test suite, and is outside the escrow's fixed-destination
   property. Its mainnet treatment is undecided (options: remove slashing, route slashed
   funds to a non-platform destination, or keep it as disclosed). Counsel should assume it
   is in scope until that decision is made (see Q2a).
4. **Most settlement paths need no platform action at all, and most do not evaluate the
   work.** The worker claims payment directly (`releaseAfterReview` once the agent's review
   window of 12 hours to 14 days elapses with no failing verdict; `releaseAfterArbitration`
   if a dispute times out; `claimWithVerdict` with a platform-signed passing verdict). Only
   `claimWithVerdict` involves any assessment of the submission. Silence favours the worker
   by design (`ADR-0001` D6). The agent confirms or refunds directly
   (`completeTask`, `expireTask` — both pull-payments). The platform's keys are not in the
   normal money path (`CC-082` proved a full paid lifecycle on testnet with no platform
   transaction anywhere in it).
4a. **What "verification" means here.** Acceptance criteria are committed on-chain as a hash
   at funding and cannot be changed (the human-readable description is not covered by the
   hash). Verdicts come from a deterministic off-chain checker run over an *evidence record*
   supplied by the worker (file references plus declared metadata such as capture time,
   GPS and perceptual hashes). The on-chain hash covers that record, not the underlying
   files, and the smart contract verifies only the signature on a verdict, not the
   evaluation. The platform does not independently verify that work was performed. The
   contract also permits a task with no acceptance criteria (the application layer requires
   them); such a task resolves in the worker's favour.
5. **No fee.** The platform charges nothing today. No personal revenue accrues until the
   project proves viable (recorded position, `ADR-0002` Amendment 1 A1.2).
6. **No identity verification.** The platform is pseudonymous by design — wallets only, no
   KYC (`ADR-0002` D1; `README.md` advertises "No KYC"). This is the commitment that collides
   with CDD if the platform is in scope (§6, Q6).
7. **Sanctions screening already ships.** Address-based sanctions/PEP screening of both
   wallets before any task participation is live (`CC-099`, done 2026-08-23). It is
   identity-free and proceeds regardless of this classification.
8. **All activity to date is operator-self-funded testnet.** Base Sepolia only; the escrow
   address there is `0xc6aa…E4d3` (redeployed 2026-09-01; full lifecycle proofs in `CC-082`/
   `CC-079`). No mainnet deployment exists yet (`CC-034`). No third party has ever transacted.

## 3. The regime and its dates (as at 2026-09-16)

From AUSTRAC's reform guidance and transitional rules:

- **31 March 2026** — reform commenced. Existing digital-currency-exchange registrations
  auto-converted to VASP registration; new entrants must enrol within 28 days of starting a
  designated service.
- **1 July 2026** — full obligations commenced for newly-regulated VASP services: AML/CTF
  program, initial and ongoing customer due diligence, suspicious matter reporting, threshold
  transaction reporting, 7-year record-keeping, nominated AML/CTF Compliance Officer.
- **29 July 2026 — passed.** The transitional rule letting a provider apply for registration
  by this date and *continue operating while the application was decided* has expired
  ([AUSTRAC, "Register with us as a remittance or virtual asset service provider"](
  https://www.austrac.gov.au/new-austrac/enrol-or-register/register-us-remittance-or-virtual-asset-service-provider),
  updated 30 Jul 2026). Per the same page, a VASP now **"can't start providing"** registrable
  virtual asset services **until registration is approved**, and assessment may take up to
  90 days (longer if AUSTRAC requests more information, which resets the clock).

**Practical consequence:** if counsel's answer is "in scope", the mainnet smoke test cannot
legally run until registration is granted. At up to 90+ days' lead time, this classification
is on the critical path of every downstream launch date. (If the answer is "out of scope",
nothing is filed and the reasoning is archived — §6, Q8.)

## 4. Which designated services are arguably engaged

AUSTRAC's published list of virtual-asset designated services
([virtual asset designated services](https://www.austrac.gov.au/new-austrac/designated-services-newly-regulated-entities/virtual-asset-designated-services),
updated 10 Jul 2026) — the candidates, with our facts against each:

- **Item 46A — virtual asset safekeeping service.** AUSTRAC: includes where a VASP
  "manage[s] or control[s] virtual assets or a private key that permits access to a virtual
  asset wallet or control of virtual assets of another person", expressly **"even when done
  as part of a multi-signature or other multi-person arrangement"**.
  - *For scope:* the platform deploys and owns the contract that holds the USDC for the
    task's duration; the owner's `resolveDispute`/`completeTaskByOwner` authority (§2.3) is
    discretion over which of two parties receives funds; the verdict-signer key (currently
    the same key as the owner) exercises settlement authority even in the non-disputed fast
    path; and `ReputationStake.slash` (§2.3a) lets the owner take staked worker USDC to
    itself.
  - *Against scope:* the platform holds no private key capable of moving the funds anywhere
    but the two fixed addresses; "controlling or managing" is defined by AUSTRAC as the
    ability to "hold, trade, transfer or spend … according to the owner or user's
    instructions" — arguably the contract, not the platform, holds the assets, and no
    instruction-following of that kind exists; AUSTRAC's exclusion for a person who "solely
    provides a software application" points at the pure-infrastructure reading, though the
    platform's dispute role likely defeats "solely".
- **Items 29–30 — accepting instructions to transfer virtual assets on behalf of customers /
  making transferred virtual assets available.** The agent funds the escrow *through the
  platform's MCP interface* (task creation, worker selection, spec hashing all happen
  platform-side before the agent's wallet transacts), and the worker receives the assets at
  the platform's contract. Whether this is "arranging/facilitating a transfer on behalf of"
  either party — or merely providing software the parties use themselves — is the same
  custody-flavoured question as 46A with a different statutory hook. (Note items 29–30 sit
  under "ordering institution / beneficiary institution" capacity language, which may itself
  narrow their application — we ask counsel to address this squarely in Q1.)
- **Items 50A/50B — exchanging, or making arrangements for the exchange of, virtual assets
  for money / virtual assets.** We believe these are **not** engaged: USDC goes in and the
  same USDC comes out to one of two fixed addresses; nothing is exchanged for anything. We
  state this so counsel can confirm rather than assume it, because "making arrangements" is
  defined broadly enough ("operating a platform for peer-to-peer exchange") that we prefer
  it ruled in or out explicitly.

## 5. The "carrying on a business as a VASP" and geographical-link preliminaries

- Items 46A/50A/50B bite only where the service is provided "in the course of carrying on a
  business as a virtual asset service provider". AUSTRAC's own guidance states a service is
  provided in the course of a business "for a fee **or for free** to otherwise further that
  business", and that "business" includes a venture "whether or not conducted on a regular,
  repetitive or continuous basis". **The operator's no-fee position (§2.5) therefore does
  not, by itself, defeat this element** — we regard the fee point as going to *who the
  customer is* (Q4), not to whether a business is carried on. We want counsel's view on
  whether a pre-revenue, pre-launch platform is nonetheless already "carrying on a business".
- Geographical link ([AUSTRAC geographical link requirement](https://www.austrac.gov.au/business/new-to-austrac/geographical-link-requirement),
  updated 14 Jul 2026): the operator is ordinarily resident in Australia, so criterion 2
  (Australian resident providing designated services through a permanent establishment,
  including a foreign one) appears satisfied if any designated service is provided at all.
  We treat this as a formality to confirm, not a live contest.

## 6. The questions, numbered

**Q1 — Classification.** Taking the mechanics in §2 as found (and we can provide the contract
source, audit scripts and ADRs as evidence), does operating Carbon Contractors on mainnet
constitute providing any designated service under items 46A, 29–30, or 50A/50B of table 1?
If yes, which items, and is the correct characterisation safekeeping, transfer arrangement,
or both?

**Q2 — The custody line.** Does the combination of (a) destinations fixed at funding by
bytecode, (b) no platform key able to reach any third-party destination *from the escrow*,
but (c) owner authority to choose between the two fixed destinations in a dispute, and
(d) a platform key signing the verdicts that gate the fast path (today the same key as the
owner; planned to be separated and placed behind a 2-of-4 Safe) — take the platform over the line
of "managing or controlling" virtual assets under 46A, or of "accepting instructions to
transfer" under items 29–30? We are specifically interested in how AUSTRAC's multi-signature
note (§4, 46A) interacts with a deterministic smart-contract escrow with bounded owner
discretion.

**Q2a — The staking contract.** `ReputationStake` holds worker-staked USDC and lets the
platform owner transfer slashed amounts to itself (§2.3a). Is that, independently of the
escrow, a safekeeping service (46A) or otherwise a registrable activity? Would any of the
three remedies in §2.3a (remove slashing; route slashed funds away from the platform; keep
and disclose) change the answer?

**Q3 — Business and geography.** Is a pre-revenue, pre-launch, sole-operator platform
"carrying on a business as a VASP" (§5)? Confirm the geographical link analysis.

**Q4 — Who is the customer?** The Act defines the customer per designated service in table 1's
own "customer" column. For 46A it is "the customer of the service" — circular without more.
Two AUSTRAC precedents point differently on two-party services: real-estate-style brokering
(both parties are customers) versus a solicitor's trust account (only the instructing client).
The operator's argument for the narrower reading: the platform charges **no fee** and so does
not stand as a paid broker between the parties (§2.5). The counter-weight: AUSTRAC's
"fee or for free" language (§5). If **both** agent and worker are customers, CDD reaches
worker registration directly — which collides with the platform's no-KYC architecture (Q6).
[Recorded in `ADR-0002` Amendment 1 A1.2; both precedents to be put to counsel rather than
assumed.]

**Q5 — If in scope: the sequence.** Confirm the post-29-July position: enrolment + full
registration **before** provision, 90-day assessment, no operate-while-pending. What does
"providing" commence on — first mainnet transaction? Deployment of the contract? Offering the
service publicly? The distinction matters because the contract may be deployed to mainnet
(`CC-034`) before any task is ever created, and we need to know whether deployment alone, or
first task, is the trigger.

**Q6 — If in scope: what CDD, and can D1 survive?** Full initial CDD (name, DOB, address for
individuals) is very hard to reconcile with the platform's pseudonymous design (`ADR-0002`
D1: no identity verification, ever). Two mitigations to test: (a) AUSTRAC's
simplified-due-diligence tier for low ML/TF-risk customers — does a capped-value microtask
marketplace qualify, and what minimum checks does SDD still require; (b) whether address-based
sanctions screening (already live, §2.7) satisfies any part of the CDD obligation. If full CDD
is unavoidable, we need to know what changes (the platform's public "No KYC" claim would have
to be withdrawn — that is a product decision we will make with your advice, not a surprise we
want to discover later).

**Q7 — Does testnet activity count?** All lifecycles run to date used operator-self-funded
**testnet** USDC (§2.8) — tokens with no monetary value and no secondary market. Confirm our
working assumption that testnet activity is not provision of a designated service (no
"customer", no virtual asset with economic value), so nothing to date has triggered
enrolment/registration clocks.

**Q8 — If out of scope: the memo.** We want the reasoning in writing (however brief) — which
statutory limbs are not met and why — archived in-repo alongside the engineering ADRs, so the
position survives staff turnover and is not re-derived under time pressure. This is the same
discipline we apply to engineering decisions (`ADR-0001`/`ADR-0002`).

## 7. Evidence bundle to hand over

Everything below is in the public repo (`github.com/carbon-contractors/carbon-contractors.com`)
and can be packaged for counsel on request:

- `contracts/CarbonEscrow.sol` — the v2 escrow source, annotated.
- `docs/adr/ADR-0001` D2/D5/D9 — dispute authority, re-runnable verdicts, custody stated
  separately. `ADR-0002` D1 + Amendment 1 — pseudonymity commitment and the CDD tension.
  `ADR-0006` D3 — the arbitration clock that binds the owner.
- `docs/backlog/CC-037.md` — the trust-boundary audit that verified the fixed-destination
  property (the "can't reach the money" argument, `CC-051` update 2026-07-25).
- `docs/backlog/CC-082.md`, `CC-079.md` — on-chain lifecycle proofs and the current testnet
  deployment record.
- `docs/carbon-contractors-escrow-signer-1-CAVIUM_V2_COMPRESSED-attestation.dat` + `.pub` —
  the HSM attestation for the verdict-signer key (non-exportability evidence).
- `docs/audits/2026-10-regulatory-claims-audit.md` — NOR-537 claim-by-claim code audit behind the
  2026-10-12 corrections.
- `docs/backlog/CC-099.md` — sanctions/PEP screening as shipped.
- `docs/Security-Trust-Disclosure.md` — the platform's published trust posture.

## 8. What is *not* in this instruction

- The separate ASIC / Corporations Act "Digital Asset Platform" question under the Digital
  Assets Framework Bill 2025 (commences 9 April 2027, small-scale exemption applies at our
  volumes) — tracked as `CC-051`; instruct separately or together, but do not let one answer
  be read as covering both regimes.
- Privacy Act / GDPR posture (`ADR-0002` D8) — already researched in-repo.
- Tax treatment of escrowed funds — separate advice.

Related: `CC-098` (this ticket), `CC-051`, `CC-039` (mainnet gate blocked on this),
`CC-099` (screening, done), `ADR-0001` D9, `ADR-0002` D1/A1.
