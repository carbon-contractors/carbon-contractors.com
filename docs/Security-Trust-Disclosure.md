# Security & Trust Disclosure: Zero-Secret Escrow Architecture

> ## ⚠️ Correction — 2026-07-30: this document overstated what is in force
>
> **The architecture below is built. It is not yet the thing controlling the contracts.**
>
> This document previously claimed that the HSM-held key controls the deployed escrow, and
> invited readers to confirm it on Basescan. That claim was false. Verified against Base
> Sepolia on 2026-07-30:
>
> | | Address |
> | :-- | :-- |
> | KMS/HSM-derived address (from `docs/carbon-contractors-escrow-signer-1.pub`) | `0xa8931097540e69B474013D294d0bA6A2cC853e4b` |
> | Actual `CarbonEscrow.owner()` and `ReputationStake.owner()` | `0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b` |
>
> The second address is a **conventional private key held in a local `.env.local` file.** The
> HSM key was generated and funded, but the `transferOwnership()` step in
> [HSM-Deployer-Checklist.md](HSM-Deployer-Checklist.md) (§"Authorize this address on the escrow
> contract") was never performed. The checklist recorded this accurately as an unticked box; this
> document asserted it as fact anyway.
>
> **So, plainly:** for the currently deployed contracts, a key on a developer's machine holds
> owner authority. The "no key to steal" and "wrench attack" rows in the threat table below do
> **not** apply to it. Every statement in this document about what the HSM protects should be read
> as *design intent for mainnet*, not as a description of Base Sepolia today.
>
> **What is not affected:** these are testnet contracts holding no real value —
> `totalLocked()` was `0` at time of writing, on Base Sepolia, with test USDC. No user funds were
> ever under the weaker arrangement. Mainnet deployment is gated on `CC-039`, and correcting this
> is tracked as `CC-059`.
>
> Left visible rather than quietly edited, per the disclosure policy in
> [Lessons-Learned.md](Lessons-Learned.md) §8 and `CC-056`.

As a solo developer, I recognize that trust is the most critical component of an escrow system. Rather than asking you to trust me, I have built an architecture where trust is enforced by hardware and infrastructure — not by promises.

**The intended core guarantee:** No human — including me — can access, view, copy, or extract the private key that controls the escrow contracts. The key exists only inside a hardware security module. There are no static credentials, key files, or long-lived secrets anywhere in the system.

**Status of that guarantee:** the HSM key and the federated signing path described below genuinely
exist and work. What has *not* happened is handing the contracts over to that key — see the
correction above. Until `CC-059` closes, treat this section as a statement of design, not of the
live deployment.

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

**Read the correction at the top of this file first.** Every row below describes what the HSM
arrangement protects *once the contracts are owned by the HSM key*. On the currently deployed
Sepolia contracts, owner authority sits with a raw private key in a local file, so the rows marked
**not in force** do not currently hold. Tracked as `CC-059`.

| Threat | Protection | In force today? |
|--------|-----------|-----------------|
| Developer reads/leaks the key | Impossible — key exists only inside HSM hardware | **Not in force** — the owner key is a raw key on disk |
| Attacker compromises developer's machine | No key to steal, no credentials to exfiltrate | **Not in force** — compromising the dev machine yields owner authority |
| Attacker reads environment variables | Only non-sensitive configuration metadata is stored (project IDs, resource paths) — none are secrets | **Not in force** — `DEPLOYER_PRIVATE_KEY` is a real secret in `.env.local` |
| Physical coercion ("wrench attack") | Developer cannot reveal a key that does not exist as a string, and cannot produce credentials that only infrastructure can generate | **Not in force** — the owner key exists as a string |
| Malicious code exfiltration | Nothing to exfiltrate — no key material, no JSON files, no static tokens | **Not in force** for the owner key |
| Insider abuse | Developer can trigger operations through the platform but cannot extract the key or bypass audit logging | **Not in force** — the developer can sign directly |

What *is* in force today: the HSM key exists, is non-exportable, is FIPS 140-2 Level 3, and the
Workload Identity Federation path to it works with no static credentials. Those claims are
independently checkable. They are simply not yet load-bearing for the escrow, because the escrow
does not answer to that key.

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

**This is the claim that was wrong.** It previously read: *"The Ethereum address derived from the
KMS public key matches the owner/signer address on the deployed escrow contract… Confirm they
match — proving the on-chain contract is controlled by the HSM key."*

They do not match. Please do check, and expect a mismatch:

1. `CarbonEscrow` on Base Sepolia — [`0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7`](https://sepolia.basescan.org/address/0xb9bF8dAC51f62cA237F2C439c63c9D8f16FD2ef7) — read `owner()`
2. Compare against the KMS-derived address, `0xa8931097540e69B474013D294d0bA6A2cC853e4b`, which
   you can derive yourself from the committed public key
   [`docs/carbon-contractors-escrow-signer-1.pub`](carbon-contractors-escrow-signer-1.pub):
   base64-decode the PEM body, take the last 65 bytes (the uncompressed EC point), drop the leading
   `0x04`, and `keccak256` the remaining 64 bytes — the address is the last 20 bytes of that hash
3. `owner()` currently returns `0x7863A5c4396E7aaac2e99Cb649a7Aa4F6A36B91b`, which is **not** the
   HSM key

`scripts/audit/verify-contract-owner.mjs` in this repository performs exactly that comparison and
prints all three addresses, so the check is reproducible rather than a claim. Once `CC-059` closes,
this section should say they match — and by then it will be verifiable rather than asserted.

### Zero-Credential Verification

The service account used for signing has **zero JSON keys** — this is verifiable and can be demonstrated via GCP IAM console screenshots or audit exports.

---

## Why This Matters

Traditional escrow systems ask you to trust the operator. This system removes the operator from the trust model entirely.

By moving trust from a **person** to **hardware and infrastructure** (GCP HSM + Workload Identity Federation + audited CI/CD), the escrow system remains secure even if my personal devices, accounts, or physical person are compromised. The only way to move funds is through the logic defined in the smart contracts, triggered by the audited platform application running in its verified production environment.

The key was born inside the HSM. It has never existed as a string, a file, or a variable. It never will.

---

*For technical inquiries regarding the security architecture, please open an issue on the project repository or contact the maintainer.*
