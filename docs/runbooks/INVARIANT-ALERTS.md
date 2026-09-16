# Invariant Alert Response Runbooks

**Reference:** `ADR-0003` D4, `CC-085`, `CC-086`, `CC-104`  
**Last Updated:** 2026-09-09  

---

## 0. Read the alert's class before reaching for the kill switch

Since `CC-104`, every alert states its class in the first line, because one shade of
Actions red covers four different situations:

| First line says | Class | Meaning | Kill switch? |
| :-- | :-- | :-- | :-- |
| `INVARIANT BREACH` | breach | an invariant was **observed violated** | **YES** — §2 |
| `MONITOR MISCONFIGURED` | misconfig | a monitor cannot run; its invariants are **unchecked** | No — §5 |
| `UNCHECKED (transport)` | unchecked | monitors ran, could not reach the chain | No — §6 |
| `all clear` | green | everything verified | No |

The confusion of these classes is not hypothetical: of the 32 failed runs in the 90 days
to 2026-09-09, **zero were breaches** — most were public-endpoint rate limiting (CC-048)
and one monitor SKIPping on a missing env var, all of which paged with the §2
pause-intake text. An alert channel that cries breach for a network blip is an alert
channel that gets muted before the real one arrives.

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

### Invariant 5: `verify-uptime` (CC-040)
* **Invariant:** Production `/api/health` answers HTTP 200 with every subsystem check `ok`, reporting the escrow address this repo pins.
* **Alert Meaning:** The site is down, degraded (503 names the failing subsystem), or — for the MISCONFIG variant — healthy against the *wrong* escrow.
* **Kill switch?** **No.** This is availability, not correctness (ADR-0003 D1's operational class). Existing tasks resolve on-chain regardless of the site.
* **Triage Steps:**
  1. Distinguish the variant from the alert body:
     * `FAIL — … 503. Unhealthy: <subsystem>` — the site answers; a named subsystem does not. Fix that subsystem (database → Supabase status; escrow_contract → RPC/chain health; sessions → app restart).
     * `FAIL — HTTP <n>` — the deployment or edge is broken (bad deploy, redirect loop, coming-soon gate capturing `/api/*`). Check Vercel deployments and roll back if the latest is the cause.
     * `MISCONFIGURED — production reports escrow X, expected Y` — **the site is UP and this is still urgent.** The deployment's `NEXT_PUBLIC_ESCROW_CONTRACT` has drifted from what this repo monitors. Before any new task funds, determine which address is correct: `curl https://www.carbon-contractors.com/api/health` and compare against `docs/Security-Trust-Disclosure.md`'s deployment table. This is the exact class that let the scheduled monitors watch an empty superseded contract for 15 days (2026-09-01 → 2026-09-16, CC-040).
  2. `TRANSIENT` after retries means the monitor's network path failed, not the site. Verify by hand: `curl -sS https://www.carbon-contractors.com/api/health`.
  3. Sustained failure with a green GitHub Actions run means GitHub itself is the problem — that is what the independent external uptime monitor (CC-111) exists to catch.

---

### Invariant 6: `verify-privileged-events` (CC-040)
* **Invariant:** Every `OwnershipTransferred` / `VerdictSignerUpdated` event in the escrow's history matches the committed allowlist (`scripts/audit/privileged-allowlist.mjs`).
* **Alert Meaning:** Someone with the owner key moved authority on-chain in a way no PR authorised. This is the owner-compromise detector.
* **Kill switch?** **Only if compromise is confirmed.** A confirmed unknown owner can pause or redirect everything — that is the one availability-class alert that escalates to §2.
* **Triage Steps:**
  1. Read the violation lines — which event, which block, which addresses:
     ```bash
     node scripts/audit/verify-privileged-events.mjs
     ```
  2. Do you recognise the `newOwner` / `signer` address?
     * **Yes — it was an authorised rotation done out-of-band:** land a PR adding the event to the allowlist (tx hash, block, decoded args). The monitor goes green on the next run. Add the PR review as the missing step, not the event as an exception.
     * **No:** treat as key compromise. Follow `docs/Key-Compromise-Recovery.md`. Do NOT pause claims (workers' funds must remain claimable); DO pause intake if the new owner can interfere with verdicts (`setVerdictSigner` → every task in review could auto-release on window close).
  3. A **DRILL** line in the alert means a synthetic event was injected on purpose — not an incident.

---

### Application error alerts (CC-040 — the `onRequestError` relay)
* **Alert shape:** `Carbon Contractors application error — <ErrorName> on /api/<route> (<type>)` in the ops webhook.
* **Alert Meaning:** A request failed past its own error handling — an uncaught exception in a render, route handler, or server action. The structured line (event `request_error_uncaught`, with the error message and digest) is in the Vercel logs; the webhook deliberately carries class + route + digest only.
* **Kill switch?** **No.** A single uncaught error is a bug, not an incident. The relay dedups identical (error, route) pairs per warm instance for 30 minutes, so a burst is one page, not four hundred.
* **Triage Steps:**
  1. In Vercel logs, filter `request_error_uncaught` and match the digest to get the full message and stack.
  2. Reproduce locally against the same route if possible.
  3. Escalate to §2 only if the failing route is on the money path (task funding, verdict issuance, claim) AND errors are sustained — a worker who cannot claim sees theft (ADR-0003).
  4. Message content never reaches the webhook (privacy, CC-009/ADR-0002 D9); the log line is the only place it appears, through the masking-aware logger.

---

## 4. Recovery & Resumption Protocol

Once the root cause is resolved and verified:

1. **Verify All Invariants Pass:**
   ```bash
   node --env-file-if-exists=.env.local scripts/audit/run-monitors.mjs --no-alert
   ```
   *Must report a `class green — all invariants verified` summary line with **zero SKIP**.
   As of CC-104 the registry schedules 8 monitors; a SKIP means an invariant went
   unchecked, and resuming intake over an unchecked invariant is the same mistake this
   runbook exists to prevent.*

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

---

## 5. MISCONFIGURED — the monitor is broken, not the system

**Alert shape:** `MONITOR MISCONFIGURED — N of M could not run correctly. This is not an
invariant verdict.`

A `CONF` result means the check itself failed structurally: missing env, wrong chainId on
an endpoint, an out-of-bounds contract read after a redeploy. The invariant it covers is
**unchecked**, which is not passing (ADR-0003 D3) — but nothing was observed wrong.

1. Read the verdict line — it names the env var or the read that failed.
2. Historical example: `Position 415 is out of bounds` on `verify-unclaimed`,
   2026-08-28→29 — the CC-082 redeploy moved the contract; fixed by re-deriving
   `ESCROW_DEPLOY_BLOCK` (CC-070). Current example: `verify-eas-schema` SKIPping on
   missing `EAS_SCHEMA_REGISTRY_ADDRESS`, fixed in CC-104 by wiring the env var.
3. Fix the configuration (workflow env block, repo secrets, or deploy block), never the
   contract, and re-run §4 step 1.
4. Do NOT engage the kill switch for this class unless the misconfig has persisted across
   multiple runs — a monitor that cannot run is a coverage gap, not an incident.

---

## 6. UNCHECKED (transport) — the monitors could not look

**Alert shape:** `N of M UNCHECKED (transport) — no invariant was observed violated.`

A `TRAN` result means the monitor exhausted its RPC retries (rate limiting, 429s, socket
errors). This is infrastructure weather, not a breach, and a single occurrence requires
**no action at all** — the next hourly run re-verifies from scratch (the runner is
stateless by design).

When it is NOT weather:

1. **Repeating across consecutive runs** — the alert body says so; sustained TRAN means
   the RPC path itself is degraded. Check whether `BASE_SEPOLIA_RPC_URL` is set as a repo
   secret; without it every run uses the public rate-limited endpoint (CC-048), which is
   exactly what produced the 2026-09-08 cluster. A dedicated endpoint (Alchemy /
   QuickNode / Infura free tier) removes the whole class.
2. **Sustained beyond a few hours** — treat the TRAN-covered invariants as unverified and
   weigh pausing intake per §2. An unmonitored money path is not a steady state; the
   decision point is hours, not minutes, because the monitors are stateless and the next
   green run restores full verification.
3. **All monitors TRAN simultaneously** — likely a chain-wide or provider-wide event;
   check a block explorer before touching anything.
