# Invariant Alert Response Runbooks

**Reference:** `ADR-0003` D4, `CC-085`, `CC-086`  
**Last Updated:** 2026-08-21  

---

## 1. The Core Emergency Constraint

> **"Pause intake, never disbursement."** (`ADR-0003` D4)

When an invariant monitor alerts (exit code `1` or `2`), the correct first response is **not to debug in production** — it is to **freeze new task intake immediately** while money path state is in an unknown condition.

Existing funded tasks continue along their on-chain timelines (delivery, review, dispute, expiration). **Halting settlements or claims while tasks are in flight strands funds and violates the liveness default.**

---

## 2. Immediate Step: Engage the Kill Switch

### Option A: Vercel Project Environment (Production Edge & Web)
1. Go to **Vercel Dashboard → Project Settings → Environment Variables**.
2. Set:
   ```bash
   NEXT_PUBLIC_INTAKE_PAUSED=true
   NEXT_PUBLIC_INTAKE_PAUSE_NOTICE="Task intake is temporarily paused for system maintenance. In-flight tasks and settlements continue normally."
   ```
3. Redeploy or promote to apply the edge state immediately.

### Option B: Dispatch the Emergency Broadcast
Notify team and community channels via the Discord/Webhook integration:
```bash
node --env-file-if-exists=.env.local scripts/emergency-broadcast.mjs \
  --pause \
  --reason="Invariant monitor alert under active investigation"
```

---

## 3. Per-Invariant Diagnostic & Triage Procedures

Run the offline/local monitor suite without triggering external alerts:
```bash
node --env-file-if-exists=.env.local scripts/audit/run-monitors.mjs --no-alert
```

---

### Invariant 1: `verify-escrow-solvency`
* **Invariant:** `USDC.balanceOf(CarbonEscrow) == CarbonEscrow.totalLocked()`
* **Alert Meaning:** On-chain contract solvency breach. Either funds were transferred directly without `createTask` (stranded surplus), or an accounting underflow occurred (insolvency).
* **Triage Steps:**
  1. Inspect the alert diff line:
     * `balance > totalLocked`: Surplus stranded funds (e.g. direct ERC-20 transfer or deprecated x402 payment). Escrow remains solvent; stranded funds need owner accounting review.
     * `balance < totalLocked`: **CRITICAL DEFICIT.** Escrow holds less USDC than claims owe.
  2. Query recent contract transfer events:
     ```bash
     node scripts/audit/find-deploy-block.mjs
     ```
  3. Verify which tasks are currently `Funded` or `Delivered`.

---

### Invariant 2: `verify-contract-owner`
* **Invariant:** `CarbonEscrow.owner() == Cloud KMS HSM Signer Address`
* **Alert Meaning:** Contract ownership has drifted, was transferred to an unauthorized wallet, or the configured HSM address is mismatched.
* **Triage Steps:**
  1. Read the on-chain owner:
     ```bash
     node scripts/audit/verify-contract-owner.mjs
     ```
  2. Verify against `docs/carbon-contractors-escrow-signer-1.pub` and `VERDICT_SIGNER_ADDRESS`.
  3. If ownership was compromised, prepare an emergency owner rotation from the current owner key.

---

### Invariant 3: `verify-signer`
* **Invariant:** Verdict signer produces valid secp256k1 EIP-712 signatures matching `acceptedSigners(address)`.
* **Alert Meaning:** The Cloud KMS HSM key cannot produce verdicts, credentials expired, or domain separator mismatch.
* **Triage Steps:**
  1. Check GCP authentication / Workload Identity Federation:
     ```bash
     npm run verify:kms
     ```
  2. Check EIP-712 domain separator:
     * Has `CarbonEscrow` been redeployed with a new address or version while the app still signs for the old contract?
  3. Verify GCP Cloud KMS permissions for `kms-signer-svc@carbon-contractors.iam.gserviceaccount.com`.

---

### Invariant 4: `verify-unclaimed`
* **Invariant:** No claimable worker payouts exceed the aging threshold (e.g. > 14 days in `Delivered`/`Resolved` state).
* **Alert Meaning:** Workers are not claiming settled funds (pull-payment UX friction, missing notification channel delivery, or abandoned wallets).
* **Triage Steps:**
  1. Run the audit script to identify affected tasks:
     ```bash
     node scripts/audit/verify-unclaimed.mjs
     ```
  2. Check if notification delivery failed for the assigned workers (`CC-095`).
  3. Reach out to workers via registered contact channels if available.

---

## 4. Recovery & Resumption Protocol

Once the root cause is resolved and verified:

1. **Verify All Invariants Pass:**
   ```bash
   node --env-file-if-exists=.env.local scripts/audit/run-monitors.mjs --no-alert
   ```
   *Must report `ALL CLEAR (5/5 invariants nominal)`.*

2. **Deactivate the Kill Switch:**
   In Vercel Environment Variables:
   ```bash
   NEXT_PUBLIC_INTAKE_PAUSED=false
   ```

3. **Broadcast System Resumption:**
   ```bash
   node --env-file-if-exists=.env.local scripts/emergency-broadcast.mjs \
     --resume \
     --reason="Investigation concluded. All invariant monitors verified clear."
   ```
