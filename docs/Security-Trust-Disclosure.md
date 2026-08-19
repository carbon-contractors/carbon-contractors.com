# Security & Trust Disclosure

> ## ⚠️ History — this document has been wrong twice, and both are left visible
>
> **2026-07-30 — the ownership claim was false for over three months.** This document asserted that
> the HSM-held key controlled the deployed escrow and invited readers to confirm it on Basescan.
> Verified against Base Sepolia on 2026-07-30, it did not hold:
>
> | | Address |
> | :-- | :-- |
> | KMS/HSM-derived address (from `carbon-contractors-escrow-signer-1.pub`) | `0xa8931097540e69B474013D294d0bA6A2cC853e4b` |
> | Actual `owner()` on both contracts, as of 2026-07-30 | `0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b` |
>
> The second address was a conventional private key in a local `.env.local`. The HSM key had been
> generated and funded in April, but the `transferOwnership()` step in
> [HSM-Deployer-Checklist.md](HSM-Deployer-Checklist.md) was never performed — the checklist recorded
> that honestly as an unticked box; this document asserted it as fact anyway. `Lessons-Learned.md`
> §10 has the full account. Corrected 2026-08-08 by calling `transferOwnership()` on both contracts
> ([`0xcaf22c7…`](https://sepolia.basescan.org/tx/0xcaf22c758ec388adfb51354f33094c2d94f6a96f9b821adc963c45871c882035),
> [`0xe17a8f0…`](https://sepolia.basescan.org/tx/0xe17a8f0152b65030c99422f9d9099a73157d88c58490c12c7628139ee6f7280f)).
> That was `CC-059`.
>
> **2026-08-19 — this document was pointing at a contract that had been replaced.** The escrow was
> redeployed as v2 on 2026-08-15 (`CC-082`), and this page still named the v1 address and told
> readers to check `owner()` on it. Anyone following the verification steps below between 15 and 19
> August was verifying an abandoned contract. Found during a documentation-alignment review; the
> addresses below are now v2. **No funds were ever affected** — `totalLocked()` has been `0`
> throughout, on both versions, because the funding path has never successfully run
> (`CC-081` Defect 1).
>
> Left visible rather than quietly edited, per the disclosure policy in
> [Lessons-Learned.md](Lessons-Learned.md) §8 and `CC-056`.

As a solo developer, I recognise that trust is the most critical component of an escrow system.
Rather than asking you to trust me, I have tried to build an architecture where as little as possible
*depends* on trusting me — and to state plainly the parts that still do.

---

## What the platform can and cannot do

This section is the honest summary. Everything below it is detail.

**Cannot — settled by the deployed bytecode, not by policy:**

- **Send escrowed funds anywhere except the two addresses fixed at funding.** `resolveDispute`'s
  destination is `releaseToWorker ? task.worker : task.agent`. No arbitrary destination is reachable
  by anyone, owner included. This holds against a compromised signer and against an order directed at
  the operator.
- **Refund, cancel or claw back a task in flight.** v2 has exactly three owner-only functions —
  `beginArbitration`, `resolveDispute`, `setVerdictSigner`. There is no owner-callable refund, and
  `resolveDispute` only reaches a task that is already `Disputed` or `Arbitrating`.
- **Move funds as part of normal settlement.** Since the pull-payment change
  ([`ADR-0001`](adr/ADR-0001-escrow-resolution-and-dispute-authority.md) Amendment 1) **the platform
  makes no transaction at all in the happy path.** The worker claims; the agent claims a refund. An
  earlier version of this document said "the only way to move funds is through the audited platform
  application" — that was true of v1 and is no longer true. The platform is not in the path.

**Can — stated because an unstated power is the dangerous kind:**

- **Sign verdicts.** The platform operates the deterministic checker and holds the signing key, so in
  v1 **the platform is the oracle.** That authority is bounded rather than removed: the rules are
  published, the inputs are committed on-chain as hashes, and the result is re-runnable by anyone —
  so a wrong verdict is *falsifiable*, not merely disputable. `ADR-0001` D9 sets out the plan to
  remove the privilege in v2 (permissionless bonded verdicts with a challenge window). Until then,
  this is a real trust assumption and this document should not be read as claiming otherwise.
- **Decline to sign.** If the platform will not sign a failing verdict, the review window closes and
  the worker is paid. The bias is deliberate — platform inaction must never take money from someone
  who delivered.
- **Resolve a disputed task**, to one of the two fixed addresses.

**Known single points of failure, disclosed:**

- **One key holds two roles.** The contract owner and the accepted verdict signer are the same
  HSM-held key today. Separating them is `CC-090`.
- **Subjective disputes, when that tier exists, will start out platform-curated.** The adjudication
  tier ([`ADR-0007`](adr/ADR-0007-adjudication-tier-and-arbitrator-isolation.md)) cannot bootstrap a
  juror pool from a marketplace with no users, so its first form is a vetted pool with
  platform-operated fallback capacity — which is the platform adjudicating with extra steps. It is
  designed with a published exit condition for exactly that reason. None of this exists yet.
- **Tasks in dispute depend on the owner remaining reachable.** `resolveDispute` is owner-only with
  no timeout, so a task in `Disputed`/`Arbitrating` would be stranded if the key became permanently
  unavailable. Every other path — worker claim, agent refund, early release — survives the platform
  disappearing entirely. This is `CC-091`, and the continuity design is
  [`ADR-0006`](adr/ADR-0006-continuity-succession-and-the-right-to-fork.md).

---

## The signing key

**The core guarantee:** no human — including me — can access, view, copy, or extract the private key
that controls the escrow contracts. The key exists only inside a hardware security module.

### 1. Hardware Security Module — FIPS 140-2 Level 3

The escrow key is generated and stored inside a **Google Cloud HSM**.

- **Non-exportable:** the private key material never leaves the hardware. It cannot be viewed,
  downloaded or copied.
- **Hardware-enforced:** the HSM performs the signing. There is no file, string or environment
  variable containing the key.
- **FIPS 140-2 Level 3** certified.

### 2. Zero static credentials (Workload Identity Federation)

Access to the key uses **OIDC federation**, not stored credentials.

- **No key files:** no JSON keys, API tokens or static credentials, anywhere.
- **Short-lived tokens only:** every signing operation uses a token that expires within 45 minutes
  and cannot be reused.
- **Infrastructure-locked:** only the production deployment can request signatures.

### 3. Two authentication paths

| Path | Purpose | Constraint |
| :-- | :-- | :-- |
| Runtime signing | verdict signing, and owner operations such as dispute resolution | locked to the production deployment |
| Contract deployment | deployments and ownership operations | locked to the repository via CI/CD |

### 4. Audit trail

Every signature produces an immutable entry in Google Cloud's audit log, traceable to an operation
and timestamp, and cross-referenceable against on-chain state.

### Local development fallback

`DEPLOYER_PRIVATE_KEY` still exists in local `.env.local` files for testnet developer convenience. It
holds **no owner authority** on either deployed contract, so its exposure is bounded to whatever that
fallback path itself allows. It is confirmed absent from every mainnet-facing environment as a gate
on `CC-034`.

---

## Verify it yourself

Do not take any of the above on trust — including the dated claims, which is the lesson of the
history box.

**Live deployment, Base Sepolia:**

| | Address |
| :-- | :-- |
| `CarbonEscrow` **v2** (deployed 2026-08-15, block `45494043`) | [`0xe80d03688E8fa6270668AD73191d353e522CB1b1`](https://sepolia.basescan.org/address/0xe80d03688E8fa6270668AD73191d353e522CB1b1) |
| `ReputationStake` | [`0x4cdeF542F9361201f9543512eeCd1eE834793203`](https://sepolia.basescan.org/address/0x4cdeF542F9361201f9543512eeCd1eE834793203) |
| Expected `owner()` on both — the HSM-derived address | `0xa8931097540e69B474013D294d0bA6A2cC853e4b` |
| `CarbonEscrow` v1 — **superseded, do not use** | `0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7` |

**Derive the HSM address yourself** from the committed public key
[`carbon-contractors-escrow-signer-1.pub`](carbon-contractors-escrow-signer-1.pub): base64-decode the
PEM body, take the last 65 bytes (the uncompressed EC point), drop the leading `0x04`, `keccak256`
the remaining 64 bytes — the address is the last 20 bytes of that hash.

**Or run the scripts, which is the point of them being in the repo:**

```bash
node --env-file=.env.local scripts/audit/verify-contract-owner.mjs      # owner() vs KMS-derived address
node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs   # the deployment is the one described here
node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs     # USDC.balanceOf(escrow) == totalLocked
```

Each exits non-zero on violation. They run on a schedule as well as on demand — see
[`ADR-0003`](adr/ADR-0003-monitoring-as-correctness-dependency.md), which treats monitoring as a
correctness dependency rather than an operations nicety, because several of the failure modes in this
design are silent.

### HSM attestation bundle

A cryptographically signed statement from the HSM hardware itself
([`…-attestation.dat`](carbon-contractors-escrow-signer-1-CAVIUM_V2_COMPRESSED-attestation.dat),
[chain](carbon-contractors-escrow-signer-1-combined-chain.pem)) proving the key was generated inside a
physical HSM, is non-exportable, and uses secp256k1. Verifiable against Google's published roots.

---

## Why this matters, and what it does not claim

Traditional escrow asks you to trust the operator. This design tries to reduce that to the smallest
honest surface: the operator cannot reach the money, and the operator's judgement has been replaced,
for the parts that can be mechanised, by a published rule anyone can re-run.

**What it does not claim:** that trust has been eliminated. In v1 the platform is still the referee,
one key still holds two roles, and a disputed task still depends on that key being reachable. Those
are written above rather than left for a reader to discover, and each has a ticket.

*For technical inquiries regarding the security architecture, open an issue on the project
repository or contact the maintainer.*
