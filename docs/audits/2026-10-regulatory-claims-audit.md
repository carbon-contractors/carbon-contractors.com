# Regulatory design-claims audit — escrow & proof-of-work verification

**Issue:** NOR-537 (Linear, North Metro Tech) · **Date:** 2026-10-02 · **Mode:** read-only code audit, no transactions, no deployments
**Scope:** `contracts/CarbonEscrow.sol`, `contracts/ReputationStake.sol`, `src/lib/checker/*`, `src/lib/contracts/*`, `src/lib/spec/*`, `src/app/api/{verdict,dispute}`, `test/CarbonEscrow.ts`, `chain-constants.json`, `docs/legal/CC-098-*.md`
**Not done:** no live-chain reads (the audit sandbox has no RPC access) and no explorer check. Anything about the *deployed* bytecode is inferred from git dates and flagged as such. Re-run `node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs` to confirm.

## Bottom line

The escrow contract itself is tight: two fixed destinations, no upgrade path, no pause, no sweep, every state has a timed exit. **Four things in the surrounding claims are not true as currently worded** and one of them is repeated in the CC-098 lawyer brief:

1. The verdict signer and the contract owner are **the same key** — the brief says they are separate.
2. `ReputationStake.slash()` sends worker-staked USDC to the platform owner — "no function can move funds anywhere else" is false for that contract.
3. The "deterministic proof of work" checks a **worker-supplied metadata record**, not the work. The evidence hash does not bind the photos/files.
4. "Funds go to the worker when proof is accepted" is only one of five ways the worker gets paid; three of them involve no evaluation at all.

None of these is a loss-of-funds bug. They are gaps between the claims and the code, so each is either a code fix or a wording change before the text goes to AUSTRAC or counsel.

## 1. Claim table

| # | Claim | Verdict | Evidence | Risk if false |
|---|---|---|---|---|
| 1 | Only two outcomes: worker on accepted proof, or refund to payer | **PARTIAL** | Destinations are always `task.worker` or `task.agent`: `CarbonEscrow.sol:693` (`_payOut`), `:556` (`resolveDispute`), `:618` (`expireTask`). But "on accepted proof" is not the trigger for most worker payouts: `releaseAfterReview` `:416` (silence), `releaseAfterArbitration` `:578` (timeout), `completeTaskByOwner` `:397` (no proof), `completeTask` `:363` (agent discretion, can fire before any submission). Only `claimWithVerdict` `:431` involves a checker result. | Statement to AUSTRAC overstates platform verification; reads as if every payout is evidence-gated. |
| 2 | No general transfer, sweep, rescue, upgrade, delegatecall, selfdestruct | **TRUE for `CarbonEscrow`; FALSE for `ReputationStake`** | Escrow: grep finds no `delegatecall`, `selfdestruct`, `assembly`, proxy or `Upgradeable`; no `receive`/`fallback`; only three `usdc.safeTransfer*` out-calls, all to the task's two parties. Stake: `ReputationStake.sol:123-138` `slash()` is `onlyOwner` and does `usdc.safeTransfer(owner(), actual)` — worker USDC to the platform, discretionary, no on-chain link to a dispute. | The brief (§2.2) says "No function, including the owner's, can direct funds to any other destination". Untrue repo-wide; counsel's safekeeping analysis (item 46A) would be built on it. |
| 3 | Platform cannot override; list every role; can it freeze? | **PARTIAL** | No pausable, proxy, or upgrade. Owner can: `resolveDispute` `:540` (pick worker or agent on a *disputed* task, within 7 days), `beginArbitration` `:512` (marker only), `completeTaskByOwner` `:397`, `setVerdictSigner` `:630`, plus inherited `transferOwnership`/`renounceOwnership`. Max freeze is bounded: 14 d review + 7 d arbitration = 21 d post-delivery (`:91`, `:101`, test `:1221`). Owner cannot reach `Disputed` alone (needs a party to present a failing verdict) — **but the signer of that verdict is the owner key** (see F1). Platform *can* choose the winner of a dispute. | The platform does hold discretionary two-way settlement power in disputes. That is a design choice; it must be described as such, not as "can't override". |
| 4 | Definition of done fixed at creation, unchangeable | **TRUE (with caveats)** | `specHash` written once in `createTask` `:308`; no setter anywhere. `submitWork` requires `specVersionAck == specHash` `:343`; verdicts bind `specHash` `:666`. DB columns immutable by trigger (`supabase/migrations/016_acceptance_spec.sql`), and a spec/hash mismatch makes the verdict service throw (`verdict-service.ts`, spec-hash check). Caveats: (a) contract accepts `specHash == 0` `:278-281`, test `:336` — only the app layer mandates a spec (`mcp/server.ts:385`), so a direct `createTask` call bypasses it; (b) the preimage lives only in Supabase — chain holds the hash; (c) ADR-0001 A2.1: the prose description is deliberately **not** covered by the hash, only the machine criteria; (d) a spec with no criteria is valid and always resolves to the worker (`funding.ts:238`). | A claim that "the job definition is fixed" is true of the criteria, not the description. Platform loss/outage makes the preimage unrecoverable by a third party. |
| 5 | Proof-of-work verification is deterministic | **PARTIAL** | Acceptance is **not** decided on-chain. The contract only recovers an EIP-712 signature and checks the signer is in `acceptedSigners` (`_consumeVerdict` `:656-678`); it does not verify `checkerHash`, `breakdownHash` or `passed` against anything. Off-chain, `evaluateEvidence` (`checker/evaluator.ts`) is a genuinely pure function and fails closed. But its input is a worker-built JSON of *claims* — `uri`, `exif.{lat,lon,dateTimeOriginal,cameraMake}`, `phash`, `c2paAiGenerated` (`checker/evidence-hash.ts:32-56`) — extracted "upstream and out of band" (`checker/types.ts:11,16`). `evidenceHash` is `keccak256` of that JSON, so it proves integrity of the record, **not** that the files exist, match the URIs, or carry that EXIF. A worker can write any EXIF values and pass. Signer: GCP Cloud KMS HSM key `0xa893…e4b`, non-exportable; compromise consequences in F1. | "Deterministic proof of work" will be read as "the work is verified". What is verified is that a declared record satisfies declared criteria. |
| 6 | No PII on-chain | **TRUE** | Events carry only ids, addresses, amounts, timestamps and hashes (`:187-220`). `taskId = keccak256(payment_request_id)` where the id is `randomBytes(16)` (`payments/funding.ts:155`) — not derived from identity. EAS schema (`chain-constants.json`) fields: taskId, escrow, chainId, agent, amount, route, completedAt and four hashes. Caveat: wallet addresses are persistent identifiers and amounts/timing are public; "pseudonymous", never "anonymous" (ADR-0004). | Low. Wording only. |
| 7 | Disputes and timeouts; funds never stuck | **TRUE (with edge cases)** | Every state has a timed exit: `Funded` → agent `expireTask` after deadline `:605`; `Delivered` → worker `releaseAfterReview` after window `:416`; `Disputed`/`Arbitrating` → worker `releaseAfterArbitration` after 7 d `:578`, and `resolveDispute` reverts after the window `:548`. Silence after delivery defaults to the **worker**, not a refund; refund-by-default happens only when nothing was submitted. Tests cover all of these including exact-second boundaries (`test/CarbonEscrow.ts:466-533`, `:1066-1241`). Edge cases that *can* strand funds: the only entitled caller's key is lost (agent in `Funded`, worker in `Delivered`); the payee is USDC-blacklisted by Circle (transfer reverts forever); agent sets an absurdly far `deadline` (contract bounds review window but not deadline). | "Funds can never be stuck" is too strong; "every state has a bounded exit available to the entitled party" is accurate. |
| 8 | USDC only | **TRUE** | One `immutable IERC20 usdc` per contract (`CarbonEscrow.sol:86`, `ReputationStake.sol:23`). No swap, router, bridge, fiat-ramp or second-token code in `src/`, `scripts/` or `contracts/` (grep for uniswap/1inch/onramp/moonpay/transak/stripe/bridge/USDT/WETH/DAI: only unrelated CSS `display: swap`). `BuyMeACoffee.tsx` is a plain USDC `transfer` to a tip wallet and is currently unmounted. Caveats: the token address is a deploy-time constructor argument (nothing on-chain proves it is the real USDC); USDC itself is an upgradeable, blacklistable token controlled by Circle. | Low. |

## 2. Payment flow and privileged roles (plain English)

**Flow.** The hiring agent commits to an acceptance spec; the platform stores the spec and returns its hash. The agent approves USDC and calls `createTask` from its own wallet, naming the worker and the spec hash. USDC moves from the agent into the escrow contract. The worker delivers by calling `submitWork` with a hash of their evidence record. From there:

- the agent can pay at any time (`completeTask`);
- the worker can claim immediately with a platform-signed *passing* verdict (`claimWithVerdict`);
- or the worker can claim after the agent's review window (12 h – 14 d) closes with no failing verdict (`releaseAfterReview`);
- the agent (or worker) can open a dispute only by presenting a platform-signed *failing* verdict inside the review window; the owner then rules worker-or-agent within 7 days, and if it does not, the worker claims (`releaseAfterArbitration`);
- if nothing is ever submitted, the agent reclaims after the deadline (`expireTask`).

Every payout is a pull by the entitled party, except `resolveDispute` and `completeTaskByOwner`, which the owner sends. No path pays a third address.

**Privileged roles and keys.**

| Role | Holder | Can do | Cannot do |
|---|---|---|---|
| Contract owner (`Ownable`) | One GCP Cloud KMS HSM key `0xa8931097…e4b` (Sepolia); target 2-of-4 Safe before mainnet (ADR-0006 D2, CC-090) | `resolveDispute` → worker *or* agent (disputed tasks, ≤7 d); `completeTaskByOwner` → worker (Funded/Delivered); `beginArbitration`; `setVerdictSigner`; transfer/renounce ownership; **`ReputationStake.slash` → itself**; `setMinStake` | Pay a third address from the escrow; pause; upgrade; withdraw; extend the arbitration window |
| Verdict signer (`acceptedSigners`) | **Same key as owner** (`chain-constants.json` `verdictSignerSeparation.separated: false`) | Sign passing or failing verdicts for any Delivered task; burn its own nonces | Move funds directly; verdicts expire in 1 h, bind task + spec + evidence + chain + contract, are single-use |
| Agent (per task) | Any funder | `completeTask`, `expireTask` (after deadline), `disputeTask` | Withhold payment by silence alone; dispute without a signed failing verdict |
| Worker (per task) | Address named at funding | `submitWork`, `releaseAfterReview`, `claimWithVerdict`, `releaseAfterArbitration`, `disputeTask` | Claim before the review window without a passing verdict |
| Anyone | — | `revokeVerdictNonce` (only if an accepted signer) | — |

**Key-compromise blast radius.** Compromised owner/signer key: can mark any Delivered task as passed (pays *that task's* worker), can set a hostile signer, can rule disputes either way. Cannot send escrowed USDC to an attacker-controlled address unless the attacker is already a task's worker or agent. Practical theft route: attacker is the worker on someone else's task and signs a passing verdict for themselves; or attacker is the agent, obtains a failing verdict, and rules the dispute in their favour.

## 3. Findings, ranked

**F1 — HIGH (claim accuracy): signer and owner are one key.** The brief (§2.3) says disputes need a verdict "from the platform's separate verdict-signer key". On Sepolia the accepted signer is the owner address; `chain-constants.json` records `separated: false`. The independence between "who can create a dispute" and "who rules it" does not exist today. A platform acting as agent (any address can fund) can sign itself a failing verdict and then rule in its own favour against a worker who delivered. Fix: complete CC-090 (separate HSM key + 2-of-4 Safe owner) before mainnet, and correct the brief now.

**F2 — HIGH (claim accuracy / code): `ReputationStake.slash` pays the platform.** `ReputationStake.sol:123-138`. Worker USDC goes to `owner()` at owner's sole discretion; no on-chain dispute linkage; the contract has **no test file** (`test/` contains only `CarbonEscrow.ts`). This is the one place the platform can take a customer's USDC. Fix options: (a) route slashed funds to a burn/escrow-refund destination fixed at deploy; (b) drop slashing from the mainnet scope; (c) keep it and disclose it to counsel as a platform-receivable. Add tests either way.

**F3 — HIGH (claim wording): proof-of-work check evaluates declared metadata.** `evidence-hash.ts` + `evaluator.ts`. A worker can fabricate EXIF GPS/time/camera fields, pHash and the C2PA flag; artefact bytes are not hash-bound (only `uri`). Fix is product work: bind artefact content hashes into the bundle and have a platform-side extractor read the bytes (ADR-0010's pre-signed upload path is the natural hook). Until then, never describe it as verifying the work.

**F4 — MEDIUM: three of five worker payout paths involve no evaluation** (`releaseAfterReview`, `releaseAfterArbitration`, `completeTaskByOwner`), and `completeTask` can pay before any submission. By design (silence favours the worker, ADR-0001 D6), but it contradicts "paid when proof accepted". Reword the claim; do not change the code.

**F5 — MEDIUM: Sepolia bytecode likely predates `completeTaskByOwner`.** Added in `c899245` (2026-09-16, #211); the Sepolia escrow was redeployed 2026-09-01. The repo ABI includes the function and the brief cites it as live. Not confirmed on chain (no RPC here). Check with the deployment audit script; update the brief or redeploy.

**F6 — MEDIUM: `specHash == 0` allowed at contract level.** Test `:336` pins it. Any agent calling `createTask` directly bypasses the app's spec requirement; such a task can only resolve to the worker. Safe for funds, but "definition of done is fixed at creation" does not hold for those tasks. Consider a contract-level `require(specHash != 0)` in the mainnet build (CC-034 is the only cheap moment).

**F7 — LOW: stranding edge cases** (lost entitled-party key; USDC blacklist; unbounded `deadline`). Mitigations: bound `deadline` (e.g. ≤ 90 d) at mainnet; document the blacklist dependency in the continuity plan.

**F8 — LOW: no contract-level test for claim 2 and 3 negatives.** Tests prove destinations for the paths that exist (`:674`, `:1030`) but nothing asserts the *absence* of upgrade/sweep/pause. Absence is structural (verified here by source grep), but a bytecode-level check (no `DELEGATECALL`/`SELFDESTRUCT` opcodes in the deployed code) would make it re-runnable.

**Security notes (brief).** Reentrancy: all USDC-moving functions are `nonReentrant` except `disputeTask`, which makes no external call. Signature replay: EIP-712 domain binds chain and contract, per-signer nonce, mandatory expiry; OpenZeppelin `ECDSA.recover` rejects malleable signatures. Access control matches the comments throughout. No findings above Low in the escrow itself.

## 4. Test coverage of claims 1–7

| Claim | Covered by | Gap |
|---|---|---|
| 1 | Per-route payout and destination tests (`:429-690`, `:1030`) | No test that `Funded`+owner cannot refund the agent without dispute |
| 2 | `reaches no destination other than the two parties` (`:674`, `:1030`); solvency invariant (`:1283`) | No negative test for sweep/upgrade absence; **ReputationStake: none** |
| 3 | Owner-only restrictions (`:633`, `:856`, `:988`) | No test of owner+signer-as-same-key abuse scenario (F1) |
| 4 | `submitWork` spec-ack mismatch (`:396`), verdict commitment mismatch (`:772`) | No test that `specHash` is immutable (structural); zero-spec accepted (`:336`) |
| 5 | Checker canary and evaluator tests in `src/lib/checker/__tests__`; on-chain signature tests (`:689-868`) | Nothing tests that the contract rejects a *wrong* `checkerHash`/`passed` signed by an accepted signer — it accepts them by design |
| 6 | None (structural) | A test asserting event ABIs contain only static types would pin it |
| 7 | Extensive, exact-second boundary tests (`:466-533`, `:1066-1241`) | Lost-key and blacklist scenarios untested |
| 8 | None | Structural; add a repo grep or CI check |

## 5. Recommended fixes, by severity

1. **Before any text goes to AUSTRAC/counsel:** correct the CC-098 brief — separate signer (F1), "no function can move funds elsewhere" excludes `slash` (F2), `completeTaskByOwner` deployment status (F5), and "proof accepted" wording (F3, F4).
2. **Before mainnet (CC-034/CC-090):** split signer from owner; move owner to the 2-of-4 Safe; decide the fate of `slash` (F2); consider `specHash != 0` and a `deadline` cap in the mainnet bytecode (F6, F7).
3. **Product work:** bind artefact bytes into `evidenceHash` and extract EXIF/pHash platform-side (F3).
4. **Tests:** ReputationStake suite; bytecode opcode check; owner-as-agent scenario test.

## 6. Suggested ADR wording — "Two-outcome escrow & deterministic proof of work"

> **Status:** proposed. **Context:** the platform's regulatory position depends on describing precisely what the escrow can and cannot do.
>
> **Decision.** (1) Escrowed USDC has exactly two destinations per task — the worker address and the agent address fixed at funding — and no function, role or upgrade path in `CarbonEscrow` can direct it elsewhere. (2) The worker is paid when the agent confirms, when a platform-signed passing verdict is presented, or when a bounded clock expires without a valid failing verdict; the agent is refunded when no work is submitted by the deadline or when the platform arbiter rules for it within the arbitration window. (3) The acceptance criteria are committed by hash at funding and cannot be changed. (4) Verdicts are produced by a deterministic, published checker over a worker-declared evidence record and signed by an accepted signer; the contract verifies the signature, not the evaluation. The checker verifies that a declared record satisfies declared criteria; it does not independently verify that the underlying work occurred. (5) The verdict signer and the contract owner are distinct keys, the owner being a multi-party Safe. (6) No other token, swap, bridge or fiat ramp exists in any platform contract or service. (7) `ReputationStake` is out of scope of this ADR and is governed by its own ADR (slashing destination to be decided).
>
> **Consequences.** The platform retains discretionary two-party adjudication in disputes, bounded to 7 days and defaulting to the worker. Claims to regulators describe this adjudication role explicitly rather than as the absence of any platform control.

## Observations (out of scope, not filed)

- `docs/Key-Compromise-Recovery.md` still references `signer_complete_task_submit` log events for a function removed in CC-080.
- `src/lib/contracts/escrow-abi.ts` contains `completeTaskByOwner` while the live Sepolia deployment probably does not; the ABI-drift guard (`escrow-abi-drift.test.ts`) covers `getTask` width only.
