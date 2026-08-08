# Security & Trust Disclosure: Zero-Secret Escrow Architecture

> ## ⚠️ History — found wrong 2026-07-30, corrected 2026-08-08
>
> **This document once claimed the HSM-held key controlled the deployed escrow. That claim was
> false when it was written, for over three months.**
>
> This document originally asserted the match below and invited readers to confirm it on
> Basescan. Verified against Base Sepolia on 2026-07-30, it did not hold:
>
> | | Address |
> | :-- | :-- |
> | KMS/HSM-derived address (from `docs/carbon-contractors-escrow-signer-1.pub`) | `0xa8931097540e69B474013D294d0bA6A2cC853e4b` |
> | Actual `CarbonEscrow.owner()` and `ReputationStake.owner()` (as of 2026-07-30) | `0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b` |
>
> The second address was a conventional private key held in a local `.env.local` file. The HSM
> key had been generated and funded back in April, but the `transferOwnership()` step in
> [HSM-Deployer-Checklist.md](HSM-Deployer-Checklist.md) was never actually performed —
> the checklist recorded this honestly as an unticked box; this document asserted it as fact
> anyway. See `Lessons-Learned.md` §10 for the full account of how that happened.
>
> **This has since been corrected.** On 2026-08-08, `transferOwnership(0xa8931097540e69B474013D294d0bA6A2cC853e4b)`
> was called on both contracts — transaction hashes
> [`0xcaf22c7…`](https://sepolia.basescan.org/tx/0xcaf22c758ec388adfb51354f33094c2d94f6a96f9b821adc963c45871c882035)
> (CarbonEscrow) and
> [`0xe17a8f0…`](https://sepolia.basescan.org/tx/0xe17a8f0152b65030c99422f9d9099a73157d88c58490c12c7628139ee6f7280f)
> (ReputationStake), both confirmed on-chain with `OwnershipTransferred` emitted. The rest of this
> document now describes the live state, not just the design intent — verify it yourself using the
> On-Chain Verification section below, which still tells you exactly how to check.
>
> **What was never affected:** these are testnet contracts holding no real value —
> `totalLocked()` was `0` throughout. No user funds were ever under the weaker arrangement.
> Mainnet deployment is gated on `CC-039`, which this closes the way for.
>
> Left visible rather than quietly edited, per the disclosure policy in
> [Lessons-Learned.md](Lessons-Learned.md) §8 and `CC-056` — this is `CC-059`, now closed.

As a solo developer, I recognize that trust is the most critical component of an escrow system. Rather than asking you to trust me, I have built an architecture where trust is enforced by hardware and infrastructure — not by promises.

**The core guarantee:** No human — including me — can access, view, copy, or extract the private key that controls the escrow contracts. The key exists only inside a hardware security module. There are no static credentials, key files, or long-lived secrets anywhere in the system.

**Status of that guarantee:** the HSM key and the federated signing path described below exist,
work, and — as of 2026-08-08 — are what actually controls both deployed contracts. See the history
box above for the period during which that was not yet true.

---

## How It Works

### 1. Hardware Security Module (HSM) — FIPS 140-2 Level 3

The escrow signing key is generated and stored inside a **Google Cloud HSM**.

- **Non-exportable:** The private key material never leaves the hardware. It cannot be viewed, downloaded, or copied — not by me, not by Google, not by anyone.
- **Hardware-enforced:** The HSM hardware itself performs the cryptographic signing. There is no digital file, string, or environment variable containing the private key.
- **Industry standard:** FIPS 140-2 Level 3 certification — the same standard used by financial institutions and government agencies.

### 2. Zero Static Credentials (Workload Identity Federation)

I do not use traditional credentials (API keys, service account JSON files, or stored secrets) to access the signing key. Instead, the system uses **OIDC federation** — the same zero-trust authentication pattern used by large enterprises.

- **No key files:** There are no JSON keys, API tokens, or static credentials stored anywhere — not in environment variables, not in code, not on my machine.
- **Short-lived tokens only:** Every signing operation uses a temporary token that expires within 45 minutes and cannot be reused.
- **Infrastructure-locked:** Only the specific production deployment of the Carbon Contractors platform can request signatures. The signing path is cryptographically bound to the correct application environment.
- **No human in the loop:** The authentication chain is machine-to-machine. I cannot manually invoke the signing key, even if I wanted to.

### 3. Dual Authentication Paths

The system has two separate, independently constrained authentication paths:

| Path | Purpose | Constraint |
|------|---------|-----------|
| **Runtime signing** | Escrow operations (fund, complete, dispute, expire) | Locked to the production deployment of the platform application |
| **Contract deployment** | Smart contract upgrades and deployments | Locked to the specific GitHub repository via CI/CD pipeline |

Both paths authenticate via OIDC federation to the same HSM key. Neither path involves static credentials.

### 4. Transparent Audit Trail

Every time the escrow key signs a transaction, a permanent, immutable log is generated in Google Cloud's audit system.

- Every signature is traceable to a specific operation and timestamp
- Signing rate is monitored with anomaly detection alerts
- Audit logs can be cross-referenced against on-chain transactions for full accountability

---

## What This Protects Against

As of 2026-08-08 (see the history box at the top), the deployed contracts are owned by the
HSM-derived address, so the rows below are in force for the currently deployed Sepolia contracts.
`DEPLOYER_PRIVATE_KEY` still exists in local `.env.local` files for developer convenience on
testnet — see the note under "Local Development Fallback" — but it no longer holds owner authority
on either contract, so its exposure is bounded to whatever that fallback path itself allows, not to
escrow ownership.

| Threat | Protection | In force? |
|--------|-----------|-----------------|
| Developer reads/leaks the key | Impossible — key exists only inside HSM hardware | **Yes** — verify via `scripts/audit/verify-contract-owner.mjs` |
| Attacker compromises developer's machine | No key to steal, no credentials to exfiltrate | **Yes** — the local raw key no longer carries owner authority |
| Attacker reads environment variables | Only non-sensitive configuration metadata is stored (project IDs, resource paths) — none are secrets, in the deployed environment | **Yes**, for the deployed Vercel environment |
| Physical coercion ("wrench attack") | Developer cannot reveal a key that does not exist as a string, and cannot produce credentials that only infrastructure can generate | **Yes** |
| Malicious code exfiltration | Nothing to exfiltrate — no key material, no JSON files, no static tokens | **Yes** |
| Insider abuse | Developer can trigger operations through the platform but cannot extract the key or bypass audit logging | **Yes** |

The HSM key exists, is non-exportable, is FIPS 140-2 Level 3, and the Workload Identity Federation
path to it works with no static credentials — and, since 2026-08-08, is what the deployed contracts
actually answer to. All of the above is independently checkable; none of it is asserted on trust.

---

## Verification for Power Users

You do not have to take my word for any of this. The following artifacts are available for independent verification:

### HSM Attestation Bundle

A **cryptographically signed statement from the HSM hardware itself**, proving:

1. The key was generated inside a physical HSM
2. The key is set to non-exportable status
3. The key uses the correct algorithm (secp256k1) for Ethereum compatibility

This attestation is signed by Google's HSM infrastructure and can be independently verified against Google's published root certificates.

### On-Chain Verification

**The Ethereum address derived from the KMS public key matches the owner address on both deployed
contracts, as of 2026-08-08.** This was false for the prior three months (see the history box at
the top) — check it yourself rather than taking that fixed-date claim on trust either:

1. `CarbonEscrow` on Base Sepolia — [`0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7`](https://sepolia.basescan.org/address/0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7) — read `owner()`
2. `ReputationStake` on Base Sepolia — [`0x4cdeF542F9361201f9543512eeCd1eE834793203`](https://sepolia.basescan.org/address/0x4cdeF542F9361201f9543512eeCd1eE834793203) — read `owner()`
3. Compare both against the KMS-derived address, `0xa8931097540e69B474013D294d0bA6A2cC853e4b`,
   which you can derive yourself from the committed public key
   [`docs/carbon-contractors-escrow-signer-1.pub`](carbon-contractors-escrow-signer-1.pub):
   base64-decode the PEM body, take the last 65 bytes (the uncompressed EC point), drop the leading
   `0x04`, and `keccak256` the remaining 64 bytes — the address is the last 20 bytes of that hash
4. Both `owner()` calls now return `0xa8931097540e69B474013D294d0bA6A2cC853e4b` — the HSM key —
   confirmed by the `OwnershipTransferred` events on the transactions linked in the history box

`scripts/audit/verify-contract-owner.mjs` in this repository performs exactly that comparison and
prints all three addresses plus a PASS/FAIL verdict, so the check is reproducible rather than a
claim.

### Zero-Credential Verification

The service account used for signing has **zero JSON keys** — this is verifiable and can be demonstrated via GCP IAM console screenshots or audit exports.

---

## Why This Matters

Traditional escrow systems ask you to trust the operator. This system removes the operator from the trust model entirely.

By moving trust from a **person** to **hardware and infrastructure** (GCP HSM + Workload Identity Federation + audited CI/CD), the escrow system remains secure even if my personal devices, accounts, or physical person are compromised. The only way to move funds is through the logic defined in the smart contracts, triggered by the audited platform application running in its verified production environment.

The key was born inside the HSM. It has never existed as a string, a file, or a variable. It never will.

---

*For technical inquiries regarding the security architecture, please open an issue on the project repository or contact the maintainer.*
