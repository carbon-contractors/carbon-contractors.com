# Checklist: Zero-Secret HSM Deployer for Base (EVM)

This document outlines the steps to create a non-exportable, hardware-protected signing key in Google Cloud with **zero static credentials** across both runtime signing (Vercel) and contract deployment (GitHub Actions).

**Design principle:** No JSON key files. No long-lived secrets. Every authentication path uses OIDC federation with short-lived tokens.

> **Note (2026-08-08):** this document originally named the service account `kms-deployer-svc`
> throughout. The one actually created is `kms-signer-svc@carbon-contractors.iam.gserviceaccount.com`
> — confirmed against the live GCP IAM console while resolving `CC-059`. Corrected below rather than
> left silently wrong.

---

## Part 1: GCP Infrastructure Setup

Follow these steps in the [Google Cloud Console](https://console.cloud.google.com/).

### 1. Enable APIs

Navigate to **APIs & Services > Library** and enable:

- Cloud Key Management Service (KMS) API
- IAM Service Account Credentials API
- Security Token Service API (required for both Vercel and GitHub OIDC federation)

### 2. Create the HSM Key

- **Key Ring:** `base-deployer-ring` (Location: `us-east1` or preferred region)
- **Key Name:** `main-deployer-key`
- **Protection Level:** Select **Hardware** (FIPS 140-2 Level 3)
- **Algorithm:** **Elliptic Curve Secp256k1 — SHA256** (`EC_SIGN_SECP256K1_SHA256`)
- **Verification:** Once created, click on the key version. It must explicitly state **"Hardware"** as the protection level.

### 3. Create the Service Account

- **Name:** `kms-signer-svc`
- **Role:** `Cloud KMS CryptoKey Signer/Verifier` (grants `cloudkms.cryptoKeyVersions.useToSign` only)
- **DO NOT create a JSON key.** Authentication is handled entirely via Workload Identity Federation. There should be zero keys listed under this service account at all times.

### 4. Derive the Ethereum Address

The KMS public key must be converted to an Ethereum address. This address becomes the signer/owner on the escrow contract.

```
Fetch KMS public key (getPublicKey API)
  → Parse PEM → extract uncompressed EC point (65 bytes, starts with 0x04)
  → Remove 0x04 prefix → 64 bytes of raw x,y coordinates
  → keccak256(64 bytes) → take last 20 bytes
  → Checksum encode → Ethereum address
```

Authorize this address on the escrow contract via `transferOwnership()` or equivalent.

---

## Part 2: Workload Identity Federation (The Trust Layer)

Instead of JSON key files that can be stolen, we link both **Vercel** (runtime signing) and **GitHub Actions** (contract deployment) directly to GCP via OIDC federation.

### Overview: Two Providers, One Pool

| Provider | Purpose | Issuer | When it fires |
|----------|---------|--------|---------------|
| `vercel-runtime` | Runtime escrow signing (completeTask, resolveDispute, etc.) | `https://oidc.vercel.com/[TEAM_SLUG]` | Every MCP tool call that triggers a blockchain transaction |
| `github-actions` | Contract deployment and upgrades | `https://token.actions.githubusercontent.com` | CI/CD deploy workflow only |

Both providers impersonate the same service account (`kms-signer-svc`) and sign with the same HSM key. They are independently constrained by attribute conditions.

### Create the Workload Identity Pool

1. Go to **IAM > Workload Identity Federation**
2. Create a pool named `carbon-contractors-pool`

### Provider 1: Vercel (Runtime Signing)

This is the **primary signing path** — every escrow transaction in production flows through here.

1. **Add Provider** to `carbon-contractors-pool`:
   - Select **OIDC**
   - Provider name: `vercel-runtime`
   - Issuer URL: `https://oidc.vercel.com/[TEAM_SLUG]` (Team mode — recommended)
   - Audience: `https://vercel.com/[TEAM_SLUG]`
   - Attribute mapping: `google.subject` = `assertion.sub`

2. **Attribute condition** (restrict to production only):
   ```
   assertion.sub.startsWith("owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:production")
   ```
   This ensures only production deployments of the correct project can request signatures. Preview, development, and other environments are blocked.

3. **Grant impersonation:** Allow this provider to impersonate `kms-signer-svc`.

#### How it works at runtime:

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

#### Vercel environment variables (all non-sensitive):

| Variable | Example Value | Secret? |
|----------|--------------|---------|
| `GCP_PROJECT_NUMBER` | `012345678901` | No |
| `GCP_WORKLOAD_IDENTITY_POOL_ID` | `carbon-contractors-pool` | No |
| `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `vercel-runtime` | No |
| `GCP_SERVICE_ACCOUNT_EMAIL` | `kms-signer-svc@project.iam.gserviceaccount.com` | No |
| `GCP_KMS_KEY_PATH` | `projects/.../keyRings/.../cryptoKeys/.../cryptoKeyVersions/1` | No |

An attacker who reads all of these cannot sign anything. They need a valid OIDC token from the correct Vercel team/project/environment, which only Vercel's infrastructure can issue.

#### Code pattern:

```typescript
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

1. **Add Provider** to `carbon-contractors-pool`:
   - Select **OIDC**
   - Provider name: `github-actions`
   - Issuer URL: `https://token.actions.githubusercontent.com`
   - Attribute mapping:
     - `google.subject` = `assertion.sub`
     - `attribute.repository` = `assertion.repository`

2. **Attribute condition** (restrict to your repo only):
   ```
   assertion.repository == "north-metro-tech/carbon-contractors"
   ```

3. **Grant impersonation:** Allow this provider to impersonate `kms-signer-svc`.

#### GitHub Actions workflow:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # Required for requesting the JWT
      contents: read
    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: 'projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/carbon-contractors-pool/providers/github-actions'
          service_account: 'kms-signer-svc@PROJECT_ID.iam.gserviceaccount.com'

      - name: Deploy to Base
        run: |
          # The 'auth' action sets up credentials automatically
          # Deploy script uses KMS key via the authenticated session
          npm run deploy:base
```

---

## Part 3: IAM Hardening

### Permissions

- Service account `kms-signer-svc` has **ONLY** `cloudkms.cryptoKeyVersions.useToSign`
- Cannot create keys, delete keys, list keys, or read key material
- Cannot modify IAM policies

### Audit Logging

Enable **Cloud KMS Data Access Logs** (Admin Read, Data Write, Data Read):

- Every signing request generates a permanent audit log entry
- Set up alerting on signing request rate for anomaly detection (potential drain attempt)
- Optionally configure IP allowlist to restrict signing to Vercel's IP ranges

### Monitoring Alerts

- Alert on > N signing requests per hour (tune N to expected volume)
- Alert on any signing request from unexpected principal
- Alert on any IAM policy changes to the service account or key

---

## Part 4: Proving Trust to Users (Transparency)

### 1. HSM Attestation

Google Cloud generates a **Signed Attestation Statement** from the HSM hardware.

- **What it proves:** The key was generated inside the HSM and is non-exportable (cannot be viewed, downloaded, or copied by anyone — including the developer).
- **How to get it:** In the KMS Console, click **"Verify Attestation"** on the key version. Download the attestation bundle and host it in the project's GitHub repo or docs site.

### 2. Zero-Credential Architecture Proof

Publish the following verifiable facts:

- **No service account JSON keys exist** — verifiable in GCP IAM console (zero keys listed under `kms-signer-svc`)
- **WIF attribute conditions** — publish the exact conditions showing only the correct Vercel project/environment and GitHub repo can authenticate
- **Audit log summary** — periodic publication of signing activity showing all signatures correlate to legitimate escrow operations

### 3. What Users Can Independently Verify

| Claim | How to verify |
|-------|--------------|
| Key is non-exportable | HSM attestation bundle (published) |
| No JSON key files exist | GCP service account key list (screenshot/audit) |
| Signing restricted to production | WIF attribute conditions (published) |
| Every signature is logged | GCP audit log exports (periodic publication) |
| Escrow contract matches KMS-derived address | On-chain contract owner address vs published KMS public key |

---

## Part 5: Local Development Fallback

For local development and testnet, the system falls back to a raw private key:

```typescript
// src/lib/contracts/signer.ts
export async function getSigner() {
  if (process.env.GCP_KMS_KEY_PATH) {
    // Production: KMS via Vercel OIDC → GCP WIF
    return getKmsAccount();
  }
  // Local dev: raw key from .env.local (testnet only)
  return privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
}
```

The testnet raw key is irrelevant to production security. The mainnet key is born in the HSM and never exists anywhere else.

---

## Part 6: Final Security Checklist

- [ ] **No JSON keys:** Verify zero keys exist under `kms-signer-svc` in GCP IAM
- [ ] **Protection level:** Key version shows **"Hardware"** in KMS console
- [ ] **Vercel WIF locked:** Attribute condition restricts to correct team + project + production environment
- [ ] **GitHub WIF locked:** Attribute condition restricts to correct repository
- [ ] **Service account scoped:** Only `useToSign` permission — nothing else
- [ ] **Audit logging enabled:** Admin Read, Data Write, Data Read on KMS key
- [ ] **Rate alerts configured:** Anomaly detection on signing request volume
- [ ] **Attestation downloaded:** HSM attestation bundle available for user verification
- [x] **Ethereum address derived:** KMS public key → Ethereum address matches contract owner —
      verified 2026-08-08 via `scripts/audit/verify-contract-owner.mjs` (PASS on both contracts,
      after `transferOwnership()`; see `Security-Trust-Disclosure.md` and `CC-059`)
- [ ] **Local fallback works:** Raw key path still functions for testnet development
- [ ] **DEPLOYER_PRIVATE_KEY removed:** Not present in any deployed environment variables — the
      raw key no longer holds owner authority as of 2026-08-08, but the env var itself has not yet
      been removed from Vercel; tracked as the remaining step of `CC-059`

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@vercel/oidc` | Vercel OIDC token retrieval in serverless functions |
| `google-auth-library` | `ExternalAccountClient` for WIF token exchange |
| `@google-cloud/kms` | GCP Cloud KMS API client |
| `asn1js` | DER-encoded signature parsing → Ethereum r/s/v format |

## Cost

- KMS key: ~$1–3/month
- Signing operations: $0.03 per 10,000 requests
- WIF/OIDC federation: Free
- Effectively zero cost at MVP volumes
