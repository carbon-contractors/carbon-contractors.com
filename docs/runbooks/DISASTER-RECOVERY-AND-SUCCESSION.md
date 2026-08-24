# Disaster Recovery, Succession, and Continuity Runbook

**Voice & Custodianship:** Vitruvius (Documentation & Architecture)  
**Governance Authority:** `ADR-0006` (Continuity, succession, and the right to fork)  
**Related Specifications:** `ADR-0001` (A1.2, D4, D6, D9), `ADR-0002` (D8, D9), `ADR-0003` (D4, D5), `Key-Compromise-Recovery.md`, `HSM-Deployer-Checklist.md`, `INVARIANT-ALERTS.md`  
**Tracking Ticket:** `CC-091`  
**Last Updated:** 2026-08-23  

---

## 1. Architectural Philosophy & The Perpetuity Mandate

> *"The protocol and funds must exist in perpetuity after any single operator is gone, as long as others see value in it."* (`ADR-0006`)

This document is the operational manual for the catastrophic loss, incapacity, or permanent departure of the platform founder (the "QuadrigaCX archetype"), as well as total cloud infrastructure or vendor termination. Documentation is treated here as a primary instrument of care: written for a stranger, an inheritor, or a successor developer so that no operational ambiguity traps user funds or prevents the platform from being stood up elsewhere.

### 1.1 The Three Core Architectural Principles

1. **Pause Intake, Never Disbursement (`ADR-0003` D4):**  
   In any disaster, freeze new task creation immediately, but never impede the claim or settlement flow of in-flight tasks.
2. **Liveness Defaults to the Worker (`ADR-0001` D6 / `ADR-0006` D3):**  
   Platform silence, arbitrator disappearance, or operator death must never strand funds or penalize the worker who performed the work.
3. **Verifiability Over Blind Trust (`ADR-0001` D4, D9 / `ADR-0006` D8):**  
   Every piece of database state is cryptographically bound to on-chain commitments. A re-hosted backend is checkable by anyone rather than trusted.

---

## 2. Layer 1: Funds & On-Chain Settlement (QuadrigaCX Prevention)

The funds layer lives on the Base blockchain. By architectural design (`ADR-0001` Amendment 1), the platform is **entirely removed from the standard settlement path**.

### 2.1 Baseline In-Flight Settlement Resilience

When the platform hosting is completely destroyed or unreachable, on-chain settlement survives automatically:

| Path | Caller | Operational Mechanism | Survives Operator Death? |
| :--- | :--- | :--- | :--- |
| `completeTask` | Agent | Direct on-chain agent invocation | ✅ Yes |
| `releaseAfterReview` | Worker | Direct pull-claim after review window | ✅ Yes |
| `expireTask` | Anyone | Direct pull-refund to agent after task deadline | ✅ Yes |
| `claimWithVerdict` | Worker | Worker submits valid EIP-712 signature | ✅ Yes (if pre-signed) |

### 2.2 Eliminating the QuadrigaCX Stranding Vector: The Dispute & Arbitration Clock (`ADR-0006` D3)

In early contract revisions, tasks in `Disputed` or `Arbitrating` required `resolveDispute` (`onlyOwner`) with no fallback, creating the single genuine QuadrigaCX vulnerability (funds locked forever if owner key is lost).

**Contract Enforcement (`ADR-0006` D3, scoped into `CC-034`):**
1. When `beginArbitration(taskId)` is invoked, an immutable on-chain **arbitration deadline** is set (`block.timestamp + ARBITRATION_TIMEOUT_WINDOW`).
2. If the platform or 2-of-3 multisig owner fails to call `resolveDispute` before the arbitration deadline expires:
   * The task transitions to a claimable timeout state.
   * `releaseAfterArbitrationTimeout(taskId)` becomes callable by `task.worker` via pull-payment.
3. **Rationale:** Defaulting to worker rather than agent prevents griefing-by-inaction and ensures founder death or operational failure pays out the party who completed the labor.

### 2.3 Role Separation & 2-of-3 Multisig Ownership (`ADR-0006` D2, `CC-090`)

The contracts strictly separate operational signing from custodial ownership:

```
┌─────────────────────────────────────────────────────────────┐
│                    On-Chain Escrow System                   │
│                                                             │
│  ┌────────────────────────┐      ┌───────────────────────┐  │
│  │   2-of-3 Safe Owner    │      │  Verdict Signer Key   │  │
│  │   (Contract Owner)     │      │  (Cloud KMS / HSM)    │  │
│  └───────────┬────────────┘      └───────────┬───────────┘  │
│              │                               │              │
│       • resolveDispute                • EIP-712 Verdicts    │
│       • setVerdictSigner              • Zero Custody        │
│       • transferOwnership             • Loss Fails Safe     │
└──────────────┼───────────────────────────────┼──────────────┘
               │                               │
       Emergency & Overrides           Automated Workflows
```

* **Contract Owner (Cold 2-of-3 Multisig):**
  * Holds `resolveDispute`, `setVerdictSigner`, and `transferOwnership`.
  * Key 1: Aaron Clifft (Primary Operational / Ledger).
  * Key 2: Technical Succession Trustee / Secondary Cold Custody.
  * Key 3: Estate / Legal Succession Escrow.
  * *Operational Constraint:* Any invocation of `resolveDispute` must be logged publicly with reasoning in the repository (`ADR-0006` D4).
* **Verdict Signer (Hot Cloud KMS Key):**
  * Address: `0xa8931097540e69B474013D294d0bA6A2cC853e4b` (`kms-signer-svc`).
  * Holds **zero custody** and no owner privileges.
  * *Loss Behavior:* If lost, automated verdicts cease; tasks degrade cleanly to the review timeout (`releaseAfterReview`) and settle to workers automatically (`ADR-0001` D6).

---

## 3. Layer 2: Service & Infrastructure Continuity

This layer addresses the total failure of hosting providers (Vercel, Supabase, Google Cloud).

### 3.1 Continuity & Asset Register (`ADR-0006` D5)

| Asset / Service | Role / Dependency | Hosted At / Registrar | Recovery Credential / Successor Path | Failure Impact If Lapsed |
| :--- | :--- | :--- | :--- | :--- |
| **Domain** (`carbon-contractors.com`) | Human Web Ingress | Namecheap / Registrar Lock enabled | Separate recovery email (non-domain), auto-renew on 2-year cycle | Web UI unreachable; contracts & MCP unaffected |
| **DNS Management** | Anycast DNS & Edge Routing | Cloudflare | Independent Cloudflare account with backup API tokens | Routing fails; repointable via registrar NS records |
| **Frontend Application** | Next.js Web App / API | Vercel (Production) | Git repo deployment webhook; re-hostable anywhere | Web interface down; clone deployable in < 15 min |
| **Primary Database** | Postgres / Auth / Realtime | Supabase Pro (`CC-058`) | Daily automated backups + PITR; off-vendor exports | Metadata search down; on-chain state unaffected |
| **Signing Infrastructure** | EIP-712 HSM Verdict Signing | Google Cloud Platform (`carbon-contractors`) | Workload Identity Federation; break-glass IAM admin | Automated verdicts halt; fallback to review timeout |
| **Code Repositories** | Source of Truth & Backlog | GitHub (`north-metro-tech/carbon-contractors`) | Organization owners; mirrored to public git remotes | Commit pipeline blocked; local clones fully operational |

---

### 3.2 Standalone Frontend Re-Hosting Runbook (Vercel Failover)

The frontend is completely disposable. A replacement can be stood up on Cloudflare Pages, Netlify, Render, or a self-hosted Docker container in under 15 minutes.

#### Step 1: Clone and Dependencies
```bash
git clone https://github.com/north-metro-tech/carbon-contractors.git
cd carbon-contractors
npm ci
```

#### Step 2: Configure Environment Variables
Create `.env.production` (or inject into your hosting provider dashboard):
```ini
# Blockchain & Contracts (Network constants from chain-constants.json)
NEXT_PUBLIC_BASE_NETWORK=mainnet
NEXT_PUBLIC_BASE_URL=https://mainnet.base.org
NEXT_PUBLIC_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
NEXT_PUBLIC_ESCROW_CONTRACT=0x[DEPLOYED_ESCROW_ADDRESS]
NEXT_PUBLIC_VERDICT_SIGNER_ADDRESS=0xa8931097540e69B474013D294d0bA6A2cC853e4b

# Supabase / Database Integration
NEXT_PUBLIC_SUPABASE_URL=https://[PROJECT_REF].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[ANON_KEY]
SUPABASE_SERVICE_ROLE_KEY=[SERVICE_ROLE_KEY]

# Runtime / Kill-Switch Controls
NEXT_PUBLIC_INTAKE_PAUSED=false
```

#### Step 3: Build & Verification
```bash
npm run build
npm test
```

#### Step 4: Repoint DNS
Update the `CNAME` or `A` records in Cloudflare to point to the new hosting deployment.

---

### 3.3 Database Disaster Recovery (Supabase Scenario A & B)

```
┌─────────────────────────────────────────────────────────────┐
│                    Data Classification                      │
│                                                             │
│  ┌────────────────────────┐      ┌───────────────────────┐  │
│  │   Tier 1: Reference    │      │  Tier 2: Ephemeral    │  │
│  │   & Registration       │      │  Task Payload Content │  │
│  └───────────┬────────────┘      └───────────┬───────────┘  │
│              │                               │              │
│       • `humans` (Profiles)           • Task Descriptions   │
│       • Profile Signatures            • Preimages / Proofs  │
│       • Categories & Schemas          • Verdict Breakdowns  │
│              │                               │              │
│       [BACKED UP & EXPORTED]          [UNBACKED / EPHEMERAL]│
│       Restore Target: Postgres        Dropped on Retention  │
└─────────────────────────────────────────────────────────────┘
```

#### Scenario A: Supabase Instance Corruption / Outage (Provider Healthy)
1. Navigate to Supabase Dashboard → **Project Settings → Backends / Backups**.
2. Select the latest Point-in-Time Recovery (PITR) or Daily Snapshot.
3. Trigger "Restore to New Project" or restore in-place.
4. Update `NEXT_PUBLIC_SUPABASE_URL` and keys in frontend environment variables.

#### Scenario B: Total Vendor Loss (Supabase Termination / Self-Hosted Postgres Failover)
1. **Provision Standard PostgreSQL Instance:**
   Deploy vanilla PostgreSQL 16+ on any cloud VM or managed database (AWS RDS, GCP Cloud SQL, Fly.io, or bare metal).
2. **Execute Schema & DDL Migration:**
   ```bash
   # Apply Supabase database migrations sequentially from the repo
   npx supabase db push --db-url "postgresql://postgres:[PASSWORD]@[NEW_DB_HOST]:5432/postgres"
   ```
3. **Import Off-Vendor Reference Backup:**
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     -d "postgresql://postgres:[PASSWORD]@[NEW_DB_HOST]:5432/postgres" \
     tier1_registration_backup.dump
   ```
4. **Data Verification via Cryptographic Commitments (`ADR-0001` D4 / `ADR-0006` D8):**
   Execute the verification suite to prove the replacement database has not been tampered with:
   ```bash
   node --env-file-if-exists=.env.local scripts/audit/verify-commitments.mjs
   ```
5. **Enforce Retention Compliance (`ADR-0006` D8):**
   Confirm that restored databases do not contain expired task preimages:
   ```bash
   node --env-file-if-exists=.env.local scripts/audit/verify-retention.mjs
   ```

---

### 3.4 GCP Cloud KMS & Signing Access Recovery

If the Vercel Workload Identity Federation credential path is broken:

1. **Verify Cloud KMS Status:**
   ```bash
   gcloud kms keys describe escrow-signer \
     --keyring=carbon-contractors \
     --location=us-central1 \
     --project=carbon-contractors
   ```
2. **Re-Establish OIDC WIF Bindings:**
   Follow `docs/HSM-Deployer-Checklist.md` Part 2 to link the new hosting runtime OIDC provider to `kms-signer-svc`.
3. **Emergency Signer Key Rotation:**
   If the GCP project itself is lost or inaccessible, the 2-of-3 Multisig Owner invokes `setVerdictSigner(NEW_SIGNER_ADDRESS, true)` to authorize a newly provisioned signer without redeploying the escrow contract (`CC-090`).

---

## 4. Layer 3: Discoverability, Rights & Forkability

### 4.1 Legal Continuity & Licensing (`ADR-0006` D1)

- **Platform, Server, & Frontend:** Licensed under **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**.
  * Ensures that anyone operating a public or network instance must publish modified source code to users (`AGPL Section 13`).
  * Prevents proprietary capture or private enclosed forks.
- **Smart Contracts (`contracts/`):** Licensed under the **MIT License**.
  * Permissively unencumbered for wallet integrations, MCP clients, and interoperable developer tooling.
- **Copyright Holder:** Held by **Aaron James Clifft** personally. Estate provisions govern licensing administration if required.

### 4.2 Discoverability Failover (DNS for Humans, ENS for Agents — `ADR-0006` D6)

When the canonical domain `carbon-contractors.com` fails:

```
┌─────────────────────────────────────────────────────────────┐
│                    Discoverability Stack                    │
│                                                             │
│  ┌────────────────────────┐      ┌───────────────────────┐  │
│  │   Human Users (DNS)    │      │   AI Agents (ENS/MCP) │  │
│  └───────────┬────────────┘      └───────────┬───────────┘  │
│              │                               │              │
│      Cloudflare Edge DNS              `carboncontractors.eth`│
│              │                        Text Record: `url`    │
│              ▼                               ▼              │
│      Backup Web Mirrors               MCP Server Endpoint   │
└─────────────────────────────────────────────────────────────┘
```

1. **Human Fallback Announcement Channels:**
   - Primary: GitHub Repository README (`https://github.com/north-metro-tech/carbon-contractors`).
   - Secondary: Pinned IPFS hash and verified social/developer channels.
2. **Machine-Readable ENS Canonical Pointer (`CC-044` / `ADR-0006` D6):**
   - The ENS name `carboncontractors.eth` contains a `url` text record.
   - MCP clients resolve this text record dynamically at runtime rather than relying on a hard-coded Vercel URL.
   - Failover repointing is performed directly on Ethereum L1/L2, completely out-of-band from web hosting.

### 4.3 Worker Registry Self-Sovereignty (`ADR-0006` D9)

To prevent a rogue database administrator or replacement host from tampering with contractor profiles:
- Each worker profile is signed with the contractor's private key upon registration:
  $$\text{Signature} = \text{sign}(keccak256(\text{WorkerAddress} \parallel \text{Skills} \parallel \text{Rates} \parallel \text{Timestamp}))$$
- The frontend and MCP clients verify this cryptographic signature against the worker's wallet address, ensuring whitepages integrity without trusted intermediaries.

---

## 5. Governance Decision Gates & Residual Risks

This section records open governance gates and explicit residual single points of failure that require founder action:

| Decision Gate | Status | Required Action / Owner Decision | Impact If Unresolved |
| :--- | :--- | :--- | :--- |
| **G1: 2-of-3 Multisig Keyholders** | `OPEN` | Nominate Key 2 (Technical Trustee) and Key 3 (Legal/Estate Trustee). | Owner role remains on single KMS key; dispute override relies on single operator. |
| **G2: Legal Estate Key Custody** | `OPEN` | Execute estate documentation detailing custody and physical recovery of founder cold keys. | Estate cannot inherit or administer keys it cannot locate. |
| **G3: ENS Name Registration** | `OPEN` | Register `carboncontractors.eth` and set the initial `url` text record. | Agents must rely on static DNS URLs during failover. |
| **G4: Off-Vendor DB Export Script** | `OPEN` | Schedule weekly pg_dump cron targeting off-vendor S3/R2 storage for Tier 1 tables. | Vendor outage requires relying on Supabase internal snapshot export. |

### 5.1 Explicit Residual Risk Statement
*Until Gate G1 and G2 are formally executed, the authority to invoke `resolveDispute` and execute DNS failover resides solely with Aaron James Clifft. In the event of sudden founder loss prior to G1/G2 completion, standard in-flight tasks settle safely to workers via `releaseAfterReview` and contract arbitration defaults (`ADR-0006` D3), but manual dispute adjudication ceases.*

---

## 6. Quick Reference Incident Triage

```
┌─────────────────────────────────────────────────────────────┐
│                   Disaster Triage Matrix                    │
└─────────────────────────────────────────────────────────────┘
  │
  ├─► [Vercel Down / Compromised]
  │     └─► Deploy repo to alternative host (Runbook §3.2)
  │     └─► Repoint Cloudflare DNS to new host
  │
  ├─► [Supabase Down / Outage]
  │     ├─► Scenario A: Restore snapshot in Supabase (Runbook §3.3)
  │     └─► Scenario B: Run migrations against self-hosted Postgres (Runbook §3.3)
  │
  ├─► [KMS Verdict Signer Lost / Compromised]
  │     ├─► Containment: Follow Key-Compromise-Recovery.md §4
  │     ├─► Normal Flow: Settlement degrades safely to worker pull-claims
  │     └─► Rotation: 2-of-3 Owner calls setVerdictSigner(NEW_ADDRESS, true)
  │
  └─► [Founder Unreachable / Incapacitated]
        ├─► Standard Tasks: Resolve automatically via pull-payments (Runbook §2.1)
        ├─► Disputed Tasks: Resolve to worker via arbitration timeout (Runbook §2.2)
        └─► Contract Admin: 2-of-3 Trustees execute multisig quorum (Runbook §2.3)
```
