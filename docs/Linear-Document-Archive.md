# Carbon Contractors — Project Reference

Migrated from Linear project documents. Not kanban tasks \-- reference material for the owning profile's context.

## Architecture Overview — Carbon Contractors Platform

*Source: [https://linear.app/north-metro-tech/document/architecture-overview-carbon-contractors-platform-097847d43322](https://linear.app/north-metro-tech/document/architecture-overview-carbon-contractors-platform-097847d43322)*

*Created 2026-03-28* *URL: [https://linear.app/north-metro-tech/document/architecture-overview-carbon-contractors-platform-097847d43322](https://linear.app/north-metro-tech/document/architecture-overview-carbon-contractors-platform-097847d43322)*

> Purpose: Reconstructed from issue history for the benefit of future-Aaron returning after a context gap. This is what Claude Code built. Read this before touching anything.

## What This Platform Is

Carbon Contractors is a **Human-as-a-Service (HaaS) marketplace** built on Base. AI agents post work tasks and pay humans to complete them. Payment is in USDC, held in escrow on-chain until task completion is confirmed. The platform sits between agents and humans — it never holds funds directly, it controls the signing key that releases them.

## The Core Flow

```
Agent → POST /api/fund-task → x402 facilitator verifies payment → task activated
Agent → MCP tool: request_human_work → task assigned to human
Human completes work → confirms via MCP
Agent → MCP tool: confirm_task_completion → platform signer calls completeTask() on contract → USDC released to human
```

If disputed: `resolve_dispute` called by platform signer via `onlyOwner` — currently only the deployer wallet can do this.

## Stack

| Layer | Technology | Notes |
| :---- | :---- | :---- |
| Frontend / API | Next.js on Vercel | MCP server \+ API routes |
| DNS / WAF | Cloudflare | DDoS protection in front of Vercel |
| Off-chain DB | Supabase (Postgres) | Tasks, humans, notification channels, waitlist, used\_nonces |
| On-chain | Solidity contract on Base Sepolia | Escrow, task state, dispute resolution |
| Payment protocol | x402 | HTTP 402-based payment verification for task funding |
| Auth (agents) | Challenge-response wallet signature | X-Caller-Wallet header \+ nonce \+ timestamp |
| Platform signer | DEPLOYER\_PRIVATE\_KEY | Raw key in env — KMS migration completed (NOR-196) |

## Smart Contract

* Deployed on **Base Sepolia** (testnet — not mainnet yet)  
* Inherits OpenZeppelin `Ownable` — `resolveDispute()` is `onlyOwner`  
* Key functions:  
  * `completeTask()` — releases USDC from escrow to human wallet  
  * `resolveDispute()` — owner-only dispute arbitration  
* The deployer wallet address is the `owner` — this is the platform signer key

### Key Risk (historical — resolved by NOR-196)

The `DEPLOYER_PRIVATE_KEY` currently exists as a raw string. On testnet it's in `.env.local`. At mainnet it was going to Vercel Sensitive env vars. This was not good enough — anyone who compromises the key controls all escrow releases. GCP Cloud KMS migration was the pre-mainnet blocker and has since been completed.

## Supabase Schema (inferred)

| Table | Purpose | RLS Status |
| :---- | :---- | :---- |
| `humans` | Registered human workers (wallet, categories, rate\_usdc, availability, reputation\_score) | Auth-scoped — fixed in migration 005 |
| `tasks` | Task records (status, amounts, wallets, deadlines) | Immutable once funded — fixed in migration AUD-002 |
| `notification_channels` | Human contact info (email, Telegram, Discord, webhook) | PII — anon read revoked in migration 003 |
| `waitlist` | Signup waitlist | Anon read revoked |
| `used_nonces` | Replay attack prevention | Migration 006 |

### Task State Machine

Defined in `src/lib/db/tasks.ts` — `VALID_TRANSITIONS` enforces valid status progressions. DB-level enforcement added as part of AUD-005 fix.

## MCP Server Tools

The MCP server is how agents interact with the platform:

| Tool | What It Does |
| :---- | :---- |
| `request_human_work` | Agent posts a task |
| `confirm_task_completion` | Agent confirms work done — triggers on-chain release |
| `dispute_task` | Agent raises a dispute |
| `resolve_dispute` | Platform resolves dispute (owner-only on contract) |
| `get_contractor` | Returns human profile (sanitised — notification type no longer exposed) |
| `register_notification_channel` | Human registers contact method |

**Agent Auth:** Every MCP tool call includes `X-Caller-Wallet` header. Platform verifies the caller cryptographically controls that wallet via challenge-response signature. Nonce \+ timestamp included to prevent replay attacks.

## x402 Payment Flow

Task funding uses the x402 protocol (HTTP 402):

1. Agent hits `/api/fund-task`  
2. Server returns `402 Payment Required` with payment details  
3. Agent pays via x402 facilitator at x402.org  
4. Facilitator verifies payment  
5. Task activates

**Known risk:** x402.org is a single external dependency — resolved with circuit breaker (NOR-182).

## Security Posture (as of last audit 2026-03-25)

### Pre-Mainnet Blockers Remaining (at time of writing this doc)

* NOR-196 — GCP Cloud KMS migration (since completed)  
* NOR-185 — Wrench attack vector (since completed)  
* NOR-183 — Requester gas stake (still open — Todo)

### Completed Security Work

* Agent authentication — challenge-response signature verification  
* Replay attack prevention — nonce \+ timestamp on registration  
* RLS hardening — anon write removed from humans \+ notification\_channels  
* Task record immutability — funded task fields locked at DB level  
* Nonce management — concurrent signer race condition fixed  
* Rate limiting on MCP endpoints  
* x402 circuit breaker  
* Cloudflare WAF in front of Vercel  
* PII exposure fixes (notification channels, task descriptions)  
* State machine enforcement

## What's Left Before Mainnet (as of this doc's writing)

1. GCP Cloud KMS — migrate DEPLOYER\_PRIVATE\_KEY to KMS (since done)  
2. Sepolia end-to-end testing — full task lifecycle on testnet with real agent interactions  
3. Requester gas stake (NOR-183) — architectural improvement, not blocker  
4. Key compromise recovery doc (NOR-195) — incident response procedure

## Things Claude Code Built That Aaron Doesn't Fully Own Yet

* The exact contract ABI and deployment address (check repo or Supabase for contract\_address env var)  
* How the x402 facilitator verification actually works under the hood  
* The precise nonce management implementation in the concurrent signer fix  
* How `McpSessionContext` is threaded through the MCP server factory

---

---

## MVP Definition of Done — Testnet → Mainnet Gate

*Source: [https://linear.app/north-metro-tech/document/mvp-definition-of-done-testnet-mainnet-gate-19ec3ae7e8af](https://linear.app/north-metro-tech/document/mvp-definition-of-done-testnet-mainnet-gate-19ec3ae7e8af)*

*Created 2026-03-24* *URL: [https://linear.app/north-metro-tech/document/mvp-definition-of-done-testnet-mainnet-gate-19ec3ae7e8af](https://linear.app/north-metro-tech/document/mvp-definition-of-done-testnet-mainnet-gate-19ec3ae7e8af)*

**Purpose:** Every item below must be GREEN before deploying the escrow contract to Base mainnet and accepting real USDC. This is the gate between "working demo" and "platform that holds other people's money."

## Section 1: Functional QA (Does It Work?)

All tests on Base Sepolia testnet with test USDC.

### Happy Path (all must pass end-to-end)

- [ ] Contractor registers → Coinbase Smart Wallet created → wallet address stored in Supabase → profile visible to agents  
- [ ] Agent discovers contractor → MCP tool returns matching contractor profiles based on skills/availability  
- [ ] Agent funds task → x402 payment → test USDC moves from agent wallet into escrow contract → task status "funded" in DB  
- [ ] Contractor receives notification → email/webhook fires when task is funded and assigned  
- [ ] Contractor submits deliverable → task status updates in DB → deliverable recorded  
- [ ] Task completion → `confirm_task_completion` MCP tool fires → server-side signer calls `completeTask()` on-chain → USDC releases from escrow to contractor wallet → DB updates to "completed" ONLY after on-chain tx succeeds  
- [ ] Attestation created → on-chain attestation recorded for completed task → visible on contractor's reputation  
- [ ] Full cycle timing → measure: task funded → USDC in contractor wallet. Target: under 30 seconds for the on-chain portion

### Unhappy Paths (all must be tested)

- [ ] Task expiry → task not completed before deadline → `expireTask()` fires → USDC refunds to agent wallet → DB updates to "expired"  
- [ ] Dispute flow → task disputed → `resolveDispute()` called → funds go to correct party based on resolution → DB updates  
- [ ] Double completion blocked → calling `completeTask()` twice on the same task reverts on the second call  
- [ ] Invalid task ID → calling `completeTask()` with a non-existent task ID reverts cleanly  
- [ ] Insufficient escrow → attempting to release more than escrowed amount reverts  
- [ ] Unauthorized caller → any wallet other than the authorized signer calling escrow functions gets rejected

### Edge Cases

- [ ] Contractor wallet changed → if a contractor updates their wallet address after a task is funded, the payout still goes to the address locked at funding time (ON-CHAIN address, not DB address)  
- [ ] Network interruption → if the on-chain tx fails mid-flight, DB does NOT update — atomic behavior confirmed  
- [ ] Concurrent completions → two tasks completing simultaneously don't cause nonce collisions on the signer

## Section 2: Security (Is It Safe?)

### Crown Jewels Audit

- [ ] DEPLOYER\_PRIVATE\_KEY location confirmed — know exactly where this key exists (local .env, Vercel, both, neither)  
- [ ] Git history clean — DEPLOYER\_PRIVATE\_KEY was NEVER committed to the repo, not even in a since-deleted commit. If it was, that key is burned — generate a new one  
- [ ] Key separation plan confirmed — document the mainnet plan: deployer key (cold storage) vs operational signer key (Vercel env, marked sensitive)  
- [ ] SUPABASE\_SERVICE\_ROLE\_KEY marked as Sensitive in Vercel  
- [ ] UPSTASH\_REDIS\_REST\_TOKEN marked as Sensitive in Vercel

### On-Chain vs Off-Chain Trust Boundary

- [ ] CRITICAL: Wallet address source confirmed — when `completeTask()` releases USDC, the contractor wallet address comes from the ON-CHAIN escrow state, NOT from Supabase. If it reads from Supabase, this is a fund-redirection vulnerability and must be fixed before mainnet.  
- [ ] Escrow contract stores contractor wallet at funding time — confirmed that the wallet address is immutably locked when the task is funded on-chain  
- [ ] Contract upgradeability assessed — is the contract behind a proxy? If yes, who holds the upgrade authority? If no, confirm you're comfortable with immutable deployment.

### MCP Input Validation

- [ ] Task ownership verified — `confirm_task_completion` validates that the calling agent is the agent that created/funded the task  
- [ ] Task state validated — completion only fires on tasks in "funded" or "in\_progress" state, not "completed", "expired", or "disputed"  
- [ ] Rate limiting — MCP endpoints have rate limiting to prevent brute-force task manipulation  
- [ ] No PII in MCP responses — tool responses don't leak contractor emails, phone numbers, or other profile data to agents

### Supabase Hardening

- [ ] Row Level Security (RLS) enabled on all tables — no table relies solely on service role key for access control  
- [ ] Contractor can only read/write own profile — RLS policy confirmed  
- [ ] Task records immutable after funding — contractor wallet address, amount, and task ID cannot be modified via the Supabase client after task is funded  
- [ ] Anon key access scoped — SUPABASE\_ANON\_KEY (client-side) can only access what it should. Test: can an unauthenticated client read all contractor profiles? All task records?

### Platform Access

- [ ] Vercel account secured — app-based MFA (not SMS), on Tier 2 identity  
- [ ] GitHub account secured — app-based MFA, branch protection on main, no force-push  
- [ ] Supabase dashboard secured — MFA enabled, audit who has access  
- [ ] Only you have access to Vercel project settings (env vars)

### Physical Security / Coercion Resistance (Wrench Attack)

**Context:** You don't hold USDC directly, but you hold access to the infrastructure that controls USDC. The attack chain is: you → Vercel dashboard → deployer key → escrow contract → all escrowed funds. This makes physical coercion (the "$5 wrench attack") a viable threat vector once real money is in escrow. Your Supabase access is a secondary chain: you → Supabase dashboard → wallet address swap → next legitimate payout redirected.

**MVP mitigations (do before mainnet):**

- [ ] Key separation implemented — deployer key in cold storage (offline, physical), operational signer in Vercel. Coercion only yields the operational signer, not contract ownership.  
- [ ] Operational signer key marked Sensitive in Vercel — cannot be read back from dashboard, even by you under duress. Attacker gets "rotate or redeploy" not "read and copy."  
- [ ] Vercel account on hardware key auth (YubiKey) — physical token adds friction to both remote and in-person coercion. Cannot be phished.  
- [ ] GitHub account on hardware key auth (YubiKey) — prevents malicious deploy via compromised code push.  
- [ ] Supabase account on hardware key auth (YubiKey) — prevents direct DB manipulation under coercion.  
- [ ] Cold storage key location documented privately — you know where it is, it's not at home, it's not at your desk. A coercer who forces you to log into everything in front of them still can't rotate the contract signer without this key.

**Post-MVP mitigations (implement as escrow balance grows):**

- [ ] Time-lock on contract admin functions — signer rotation has a 24-hour delay. Even if coerced to initiate, there's a cancellation window.  
- [ ] Multisig on contract ownership — require 2-of-3 signatures for admin operations.  
- [ ] Maximum single-payout limit on operational signer — the signer can release individual task payouts but not drain the entire escrow in one transaction.  
- [ ] Escrow balance monitoring with alerts — automated alert if escrow balance drops by more than X% in a short window.  
- [ ] Duress protocol documented — a private plan for what to do if coerced. Which keys to burn, who to contact, how to freeze operations.

**Threat model note:** At MVP volumes (small escrow balances, \<$1,000 total), the wrench attack is not economically rational. The MVP mitigations should be in place at mainnet launch regardless, as they're good hygiene. The post-MVP mitigations scale with the money at risk.

## Section 3: Infrastructure (Is It Ready?)

### Mainnet Deployment Checklist

- [ ] Fresh deployer wallet generated — never used on testnet, never shared with Claude Code  
- [ ] Escrow contract deployed to Base mainnet — using the fresh deployer wallet  
- [ ] Fresh operational signer wallet generated — separate from deployer  
- [ ] Contract authorizes operational signer — call the appropriate function to register the new signer  
- [ ] Deployer key goes to cold storage — offline, not on any server, physical backup  
- [ ] Operational signer key added to Vercel — marked Sensitive immediately  
- [ ] All NEXT\_PUBLIC\_ contract addresses updated — pointing to mainnet contract addresses, not Sepolia  
- [ ] NEXT\_PUBLIC\_BASE\_NETWORK updated to mainnet  
- [ ] NEXT\_PUBLIC\_BASE\_URL pointing to mainnet RPC  
- [ ] NEXT\_PUBLIC\_USDC\_ADDRESS updated to mainnet USDC contract on Base

### Domain and DNS

- [ ] carbon-contractors.com pointing to Vercel deployment  
- [ ] SSL/TLS active and forced  
- [ ] /learn content published and accessible (all 6 modules)  
- [ ] SEO metadata per page for /learn section

### Monitoring (Day 1 minimum)

- [ ] Escrow contract balance — can you check it manually on Basescan?  
- [ ] Operational signer ETH balance — enough gas for initial operations  
- [ ] Vercel function logs — errors on `completeTask()` calls are visible  
- [ ] Supabase logs — failed queries and auth errors are visible

## Section 4: Business Readiness (Is It Launchable?)

- [ ] Stables affiliate approved and link integrated into Module 4 *(NOTE: superseded — Stables sunsetting, see NOR-292/NOR-304)*  
- [ ] At least one test transaction completed end-to-end on mainnet with real (small amount) USDC before public launch  
- [ ] LinkedIn outreach to Stables Melbourne COO drafted and ready *(superseded, see above)*  
- [ ] Podcast talking points solid — can explain the full lifecycle without hesitation

## Section 5: Security Sweep (Final Gate)

Run both sweep skills against the codebase as the last step before mainnet deployment.

- [ ] OWASP Top 10 Web Application sweep — run against the full Next.js codebase  
- [ ] Web3 Attack Vectors sweep (OWASP Top 15 Beyond Smart Contracts) — run against the full project  
- [ ] All CRITICAL and HIGH findings resolved  
- [ ] MEDIUM findings documented — accepted as known risk with documented rationale, or resolved  
- [ ] Findings report attached to this document — for audit trail

## Go / No-Go Decision

**GREEN \= ready for mainnet** when ALL items in Sections 1-3 and Section 5 are checked. Section 4 can have items in progress at mainnet deploy.

**If any item in Section 2 (Security) or Section 5 (Security Sweep) is RED, do not deploy to mainnet.** Full stop.

---

---

## Security & Trust Disclosure: Zero-Secret Escrow Architecture

*Source: [https://linear.app/north-metro-tech/document/security-and-trust-disclosure-zero-secret-escrow-architecture-4fb44305efd8](https://linear.app/north-metro-tech/document/security-and-trust-disclosure-zero-secret-escrow-architecture-4fb44305efd8)*

*Created 2026-04-20* *URL: [https://linear.app/north-metro-tech/document/security-and-trust-disclosure-zero-secret-escrow-architecture-4fb44305efd8](https://linear.app/north-metro-tech/document/security-and-trust-disclosure-zero-secret-escrow-architecture-4fb44305efd8)*

As a solo developer, trust is the most critical component of an escrow system. Rather than asking users to trust the operator, the architecture enforces trust via hardware and infrastructure — not promises.

**The core guarantee:** No human — including the operator — can access, view, copy, or extract the private key that controls the escrow contracts. The key exists only inside a hardware security module. There are no static credentials, key files, or long-lived secrets anywhere in the system.

## How It Works

### 1\. Hardware Security Module (HSM) — FIPS 140-2 Level 3

The escrow signing key is generated and stored inside a Google Cloud HSM.

* **Non-exportable:** The private key material never leaves the hardware.  
* **Hardware-enforced:** The HSM hardware itself performs the cryptographic signing.  
* **Industry standard:** FIPS 140-2 Level 3 certification.

### 2\. Zero Static Credentials (Workload Identity Federation)

No traditional credentials (API keys, service account JSON files, or stored secrets) are used to access the signing key. Instead, the system uses OIDC federation.

* No key files anywhere.  
* Short-lived tokens only — every signing operation uses a temporary token expiring within 45 minutes.  
* Infrastructure-locked — only the correct production deployment can request signatures.  
* No human in the loop — the authentication chain is machine-to-machine.

### 3\. Dual Authentication Paths

| Path | Purpose | Constraint |
| :---- | :---- | :---- |
| Runtime signing | Escrow operations (fund, complete, dispute, expire) | Locked to production deployment |
| Contract deployment | Smart contract upgrades/deployments | Locked to the specific GitHub repository via CI/CD |

### 4\. Transparent Audit Trail

Every signing transaction generates a permanent, immutable log in Google Cloud's audit system.

## What This Protects Against

| Threat | Protection |
| :---- | :---- |
| Developer reads/leaks the key | Impossible — key exists only inside HSM hardware |
| Attacker compromises developer's machine | No key to steal, no credentials to exfiltrate |
| Attacker reads environment variables | Only non-sensitive configuration metadata is stored |
| Physical coercion ("wrench attack") | Cannot reveal a key that does not exist as a string |
| Malicious code exfiltration | Nothing to exfiltrate |
| Insider abuse | Cannot extract key or bypass audit logging |

## Verification for Power Users

* **HSM Attestation Bundle** — cryptographically signed statement from HSM hardware proving key generated inside physical HSM, non-exportable, correct algorithm (secp256k1).  
* **On-Chain Verification** — Ethereum address derived from KMS public key matches owner/signer address on the deployed escrow contract; verifiable on Basescan.  
* **Zero-Credential Verification** — service account has zero JSON keys, verifiable via GCP IAM console.

## Why This Matters

By moving trust from a person to hardware and infrastructure (GCP HSM \+ Workload Identity Federation \+ audited CI/CD), the escrow system remains secure even if the operator's personal devices, accounts, or physical person are compromised. The key was born inside the HSM. It has never existed as a string, a file, or a variable. It never will.

---

---

## Checklist: Zero-Secret HSM Deployer for Base (EVM)

*Source: [https://linear.app/north-metro-tech/document/checklist-zero-secret-hsm-deployer-for-base-evm-80eda215ad4f](https://linear.app/north-metro-tech/document/checklist-zero-secret-hsm-deployer-for-base-evm-80eda215ad4f)*

*Created 2026-04-20* *URL: [https://linear.app/north-metro-tech/document/checklist-zero-secret-hsm-deployer-for-base-evm-80eda215ad4f](https://linear.app/north-metro-tech/document/checklist-zero-secret-hsm-deployer-for-base-evm-80eda215ad4f)*

Steps to create a non-exportable, hardware-protected signing key in Google Cloud with zero static credentials across both runtime signing (Vercel) and contract deployment (GitHub Actions).

**Design principle:** No JSON key files. No long-lived secrets. Every authentication path uses OIDC federation with short-lived tokens.

## Part 1: GCP Infrastructure Setup

### 1\. Enable APIs

Enable: Cloud Key Management Service (KMS) API, IAM Service Account Credentials API, Security Token Service API.

### 2\. Create the HSM Key

* **Key Ring:** `base-deployer-ring` (Location: `us-east1` or preferred region)  
* **Key Name:** `main-deployer-key`  
* **Protection Level:** Hardware (FIPS 140-2 Level 3\)  
* **Algorithm:** Elliptic Curve Secp256k1 — SHA256 (`EC_SIGN_SECP256K1_SHA256`)  
* **Verification:** Key version must explicitly state "Hardware" as the protection level.

### 3\. Create the Service Account

* **Name:** `kms-deployer-svc`  
* **Role:** `Cloud KMS CryptoKey Signer/Verifier` (grants `cloudkms.cryptoKeyVersions.useToSign` only)  
* DO NOT create a JSON key — authentication handled entirely via Workload Identity Federation.

### 4\. Derive the Ethereum Address

```
Fetch KMS public key (getPublicKey API)
  → Parse PEM → extract uncompressed EC point (65 bytes, starts with 0x04)
  → Remove 0x04 prefix → 64 bytes of raw x,y coordinates
  → keccak256(64 bytes) → take last 20 bytes
  → Checksum encode → Ethereum address
```

Authorize this address on the escrow contract via `transferOwnership()` or equivalent.

## Part 2: Workload Identity Federation (The Trust Layer)

Two OIDC providers, one pool — both impersonate `kms-deployer-svc` and sign with the same HSM key, independently constrained by attribute conditions.

| Provider | Purpose | Issuer | When it fires |
| :---- | :---- | :---- | :---- |
| `vercel-runtime` | Runtime escrow signing | `https://oidc.vercel.com/[TEAM_SLUG]` | Every MCP tool call triggering a blockchain transaction |
| `github-actions` | Contract deployment/upgrades | `https://token.actions.githubusercontent.com` | CI/CD deploy workflow only |

### Provider 1: Vercel (Runtime Signing)

* Provider name: `vercel-runtime`  
* Issuer URL: `https://oidc.vercel.com/[TEAM_SLUG]` (Team mode)  
* Audience: `https://vercel.com/[TEAM_SLUG]`  
* Attribute mapping: `google.subject` \= `assertion.sub`  
* Attribute condition: `assertion.sub.startsWith("owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:production")`

Runtime flow:

```
Vercel function invoked (e.g. MCP completeTask)
  → reads OIDC token from x-vercel-oidc-token request header
  → @vercel/oidc getVercelOidcToken() extracts the token
  → google-auth-library ExternalAccountClient exchanges token with GCP STS
  → receives short-lived GCP access token (~45 min max)
  → uses access token to call KMS asymmetricSign
  → KMS signs inside HSM, returns DER-encoded signature
  → server converts DER → Ethereum r/s/v
  → assembles signed tx → submits to Base
```

Vercel env vars (all non-sensitive): `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_KMS_KEY_PATH`.

Code pattern:

```ts
import { getVercelOidcToken } from '@vercel/oidc';
import { ExternalAccountClient } from 'google-auth-library';
import { KeyManagementServiceClient } from '@google-cloud/kms';

const authClient = ExternalAccountClient.fromJSON({
  type: 'external_account',
  audience: `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}`,
  subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  token_url: 'https://sts.googleapis.com/v1/token',
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
  subject_token_supplier: {
    getSubjectToken: async () => getVercelOidcToken()
  }
});

const kmsClient = new KeyManagementServiceClient({ authClient });
```

### Provider 2: GitHub Actions (Contract Deployment)

* Provider name: `github-actions`  
* Issuer URL: `https://token.actions.githubusercontent.com`  
* Attribute mapping: `google.subject` \= `assertion.sub`, `attribute.repository` \= `assertion.repository`  
* Attribute condition: `assertion.repository == "north-metro-tech/carbon-contractors"`

```
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: 'projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/carbon-contractors-pool/providers/github-actions'
          service_account: 'kms-deployer-svc@PROJECT_ID.iam.gserviceaccount.com'
      - name: Deploy to Base
        run: npm run deploy:base
```

## Part 3: IAM Hardening

* Service account has ONLY `cloudkms.cryptoKeyVersions.useToSign`  
* Cannot create keys, delete keys, list keys, or read key material  
* Cannot modify IAM policies  
* Enable Cloud KMS Data Access Logs (Admin Read, Data Write, Data Read)  
* Alert on signing request rate anomalies  
* Optional IP allowlist to Vercel's IP ranges

## Part 4: Proving Trust to Users (Transparency)

* HSM Attestation — download from KMS Console "Verify Attestation", host publicly  
* Zero-Credential Architecture Proof — publish no JSON keys exist, WIF attribute conditions, audit log summaries  
* Users can independently verify: key non-exportable, no JSON keys, signing restricted to production, every signature logged, escrow contract owner matches KMS-derived address

## Part 5: Local Development Fallback

```ts
// src/lib/contracts/signer.ts
export async function getSigner() {
  if (process.env.GCP_KMS_KEY_PATH) {
    return getKmsAccount();
  }
  return privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
}
```

## Part 6: Final Security Checklist

- [ ] No JSON keys under `kms-deployer-svc`  
- [ ] Protection level shows "Hardware"  
- [ ] Vercel WIF locked to correct team \+ project \+ production  
- [ ] GitHub WIF locked to correct repository  
- [ ] Service account scoped to `useToSign` only  
- [ ] Audit logging enabled  
- [ ] Rate alerts configured  
- [ ] Attestation downloaded  
- [ ] Ethereum address derived and matches contract owner  
- [ ] Local fallback works  
- [ ] DEPLOYER\_PRIVATE\_KEY removed from deployed environments

## Dependencies

| Package | Purpose |
| :---- | :---- |
| `@vercel/oidc` | Vercel OIDC token retrieval |
| `google-auth-library` | `ExternalAccountClient` for WIF token exchange |
| `@google-cloud/kms` | GCP Cloud KMS API client |
| `asn1js` | DER-encoded signature parsing → Ethereum r/s/v |

## Cost

\~$1–3/month for the key \+ $0.03 per 10,000 signing operations. WIF/OIDC federation is free.

---

---

