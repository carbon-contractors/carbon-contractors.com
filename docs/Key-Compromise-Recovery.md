# Key Compromise Recovery Runbook

**Last reviewed:** 2026-04-25
**Source finding:** [AUDIT-2026-03-25.md, AUD-010](../AUDIT-2026-03-25.md)
**Related work:** NOR-196 (GCP Cloud KMS signer migration)
**See also:** [HSM-Deployer-Checklist.md](HSM-Deployer-Checklist.md) (the architecture this protects), [Security-Trust-Disclosure.md](Security-Trust-Disclosure.md) (the user-facing trust statement)

This runbook describes how to rotate the platform signer and release in-flight escrow funds in the event of a suspected compromise of the credential path that authorises KMS signing.

---

## 1. When to use this runbook

Run this procedure if **any** of the following is true:

- A GCP audit log entry shows `cloudkms.cryptoKeyVersions.useToSign` from a principal you do not recognise.
- The KMS signing-rate alert (configured in NOR-196) fires outside expected operational windows.
- You observe an on-chain transaction signed by the platform signer address that you did not initiate.
- A Vercel deployment artefact, environment, or team membership has been tampered with such that an attacker could call signing endpoints.
- You have lost custody of a credential that grants Vercel team admin or GCP IAM admin (escalation path to signer authority).

The architectural threat model is narrow because of NOR-196: the private key cannot leave the HSM. "Compromise" here means a stolen *credential path* (Vercel admin, GCP IAM admin, or a malicious deploy that calls the signer), not a stolen key string.

---

## 2. Threat model — what the attacker can and cannot do

| Capability | Status | Note |
|---|---|---|
| Extract the secp256k1 private key | **No** | HSM-enforced. Key was generated inside the HSM and never existed elsewhere. |
| Sign with the current key while access lasts | **Yes** | Until WIF impersonation is revoked or the key version is disabled. |
| Call `completeTask(taskId)` for tasks where `task.agent` equals the platform signer address | **Yes** | This is the primary loss vector. |
| Call `resolveDispute(taskId, false)` to refund the agent (themselves, if they are the agent on a task) | **No** | `resolveDispute` is `onlyOwner`. If the attacker also has owner authority they can drain disputed tasks via this path. |
| Drain `totalLocked` directly | **No** | No `withdraw`, no `sweep`. Funds only move via `completeTask`, `resolveDispute`, or `expireTask`. |
| Refund expired tasks (`expireTask`) | **Anyone** | Returns funds to the original `task.agent`, not the caller. Not a loss vector. |

---

## 3. Detection signals

- **GCP audit logs.** Project: `carbon-contractors`. Filter `protoPayload.methodName="AsymmetricSign"` and inspect `protoPayload.authenticationInfo.principalEmail` and `protoPayload.requestMetadata.callerIp`. Anything outside Vercel's egress ranges or the GitHub Actions runner ranges is suspect.
- **KMS signing-rate alert** (configured during NOR-196). Triggers on `peak_qps` above the operational baseline.
- **On-chain.** Watch the platform signer address on Basescan for transactions that do not correlate with platform-side `signer_complete_task_submit` / `signer_resolve_dispute_submit` log entries (see `src/lib/contracts/signer.ts`).
- **Vercel.** Audit log for env-var changes to any `GCP_*` variable, team-member additions, or unexpected deploys to the production environment.

---

## 4. Containment (target: first 30 minutes)

The goal is to stop new signing requests succeeding. Do these in order; each step is independent of the next.

### 4.1 Revoke WIF impersonation

This is the fastest cut-off. Once the role binding is removed, neither Vercel nor GitHub Actions can mint a token that impersonates `kms-signer-svc`.

```bash
# Replace [PROJECT_ID] and [PROJECT_NUMBER] with values from Vercel env vars.
# Pool/provider names match what was created during NOR-196.

gcloud iam service-accounts remove-iam-policy-binding \
  kms-signer-svc@[PROJECT_ID].iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/[PROJECT_NUMBER]/locations/global/workloadIdentityPools/carbon-contractors-pool/attribute.repository/north-metro-tech/carbon-contractors"

gcloud iam service-accounts remove-iam-policy-binding \
  kms-signer-svc@[PROJECT_ID].iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/[PROJECT_NUMBER]/locations/global/workloadIdentityPools/carbon-contractors-pool/*"
```

Verify that signing now fails:

```bash
npm run verify:kms
# Expected: 401 / permission denied from STS or KMS.
```

### 4.2 Disable the compromised KMS key version

Disable, do **not** destroy. A destroyed key version cannot be re-enabled, and you may need it later for forensic signature verification.

```bash
gcloud kms keys versions disable [VERSION_NUMBER] \
  --key=escrow-signer \
  --keyring=carbon-contractors \
  --location=us-central1
```

### 4.3 Pause the production deployment

In the Vercel dashboard, set the production deployment to a known-good prior deploy or pause new deploys. This prevents an attacker who controls a deploy pipeline from re-introducing a malicious code path during recovery.

### 4.4 Snapshot evidence

Before any further changes, capture:

- `gcloud logging read` output for the last 7 days of `cloudkms.googleapis.com` activity.
- The current Vercel project audit log.
- The list of every `task.agent` address currently observed on the deployed escrow (see §7).

---

## 5. Generate the new signer

### 5.1 Decide: new key version or new key

- **New key version on the existing key** is sufficient if the compromise is credential-path only and the key material is uncompromised (which is the expected scenario given HSM enforcement).
- **A brand-new key on a brand-new keyring** is required if any GCP IAM admin credential is suspected — because the attacker could have set IAM policies on the existing keyring.

### 5.2 Create the key version

```bash
# New version on the existing key (default scenario):
gcloud kms keys versions create \
  --key=escrow-signer \
  --keyring=carbon-contractors \
  --location=us-central1 \
  --primary

# Capture the resulting full resource path — this is your new GCP_KMS_KEY_PATH.
gcloud kms keys versions list \
  --key=escrow-signer --keyring=carbon-contractors --location=us-central1
```

### 5.3 Derive the new Ethereum address

The address is `keccak256(uncompressed_pubkey[1:])[-20:]` — see `getEthAddressFromKms()` in [src/lib/contracts/kms-signer.ts:232](../src/lib/contracts/kms-signer.ts#L232).

```bash
# Set GCP_KMS_KEY_PATH locally to the new key path, then:
GCP_KMS_KEY_PATH="projects/[PROJECT_ID]/locations/us-central1/keyRings/carbon-contractors/cryptoKeys/escrow-signer/cryptoKeyVersions/[NEW_VERSION]" \
  npm run verify:kms
```

`verify:kms` should print the new derived address and confirm signature recovery against it. Record this address — call it `[NEW_OWNER_ADDRESS]`.

### 5.4 Re-grant WIF impersonation to the new key holder

Re-create the bindings revoked in §4.1, scoped exactly as before. Run §4.1's verify command again to confirm WIF → KMS works end-to-end before touching production.

---

## 6. Rotate ownership on-chain

The platform signer address is also the contract owner (set during deploy via OpenZeppelin `Ownable`'s constructor — see [contracts/CarbonEscrow.sol:80](../contracts/CarbonEscrow.sol#L80)). Ownership controls `resolveDispute`, which is the only path that releases in-flight escrow funds after rotation.

Call `transferOwnership(newOwner)` from the **current** owner if it is still trusted, or coordinate a recovery if owner authority itself is compromised.

```bash
# Use cast (Foundry) from a workstation with ad-hoc access to the current owner key.
# If the current owner is the (now-rotated) KMS key, sign through the OLD key path
# one final time before disabling it permanently.

cast send [ESCROW_ADDRESS] \
  "transferOwnership(address)" [NEW_OWNER_ADDRESS] \
  --rpc-url $BASE_MAINNET_RPC_URL \
  --private-key $OLD_OWNER_KEY   # or use a KMS-backed sender

# Verify:
cast call [ESCROW_ADDRESS] "owner()(address)" --rpc-url $BASE_MAINNET_RPC_URL
# Should return [NEW_OWNER_ADDRESS] (checksummed).
```

If the current owner authority is itself compromised and you have not yet been able to call `transferOwnership`, you cannot recover in-flight tasks for which the compromised key is `task.agent`. Stop here and treat this as a worst-case incident: the contract is non-upgradeable; on-chain remedies are exhausted. Escalate to legal and communications.

---

## 7. Handle in-flight tasks

This is the operational heart of AUD-010. The contract gates `completeTask` on `msg.sender == task.agent` (see [contracts/CarbonEscrow.sol:128](../contracts/CarbonEscrow.sol#L128)). For any task funded **before** rotation where the **old** signer address is `task.agent`, the new signer cannot call `completeTask`. The only release path is dispute → `resolveDispute(taskId, true)`.

### 7.1 Enumerate affected tasks

Query `TaskCreated` events filtered by the old agent address (the indexed `agent` topic), then check current state via `getTask`.

```ts
// scripts/list-inflight-tasks.ts (run with `npx tsx`)
import { createPublicClient, http, parseAbiItem } from "viem";
import { base, baseSepolia } from "viem/chains";

const client = createPublicClient({
  chain: process.env.NEXT_PUBLIC_BASE_NETWORK === "mainnet" ? base : baseSepolia,
  transport: http(process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL),
});

const ESCROW = process.env.NEXT_PUBLIC_ESCROW_CONTRACT as `0x${string}`;
const OLD_AGENT = "[OLD_SIGNER_ADDRESS]" as `0x${string}`;

const logs = await client.getLogs({
  address: ESCROW,
  event: parseAbiItem(
    "event TaskCreated(bytes32 indexed taskId, address indexed agent, address indexed worker, uint256 amount, uint256 deadline)",
  ),
  args: { agent: OLD_AGENT },
  fromBlock: 0n,
  toBlock: "latest",
});

const TaskState = ["None", "Funded", "Completed", "Disputed", "Resolved", "Expired"] as const;

for (const log of logs) {
  const taskId = log.args.taskId!;
  const task = await client.readContract({
    address: ESCROW,
    abi: [
      parseAbiItem(
        "function getTask(bytes32) view returns ((address agent, address worker, uint256 amount, uint256 deadline, uint8 state))",
      ),
    ],
    functionName: "getTask",
    args: [taskId],
  });
  if (task.state === 1 /* Funded */ || task.state === 3 /* Disputed */) {
    console.log({
      taskId,
      worker: task.worker,
      amount: task.amount.toString(),
      state: TaskState[task.state],
      deadline: new Date(Number(task.deadline) * 1000).toISOString(),
    });
  }
}
```

The output is your worklist. For each row:

- `state === Funded` → needs a dispute raised (§7.2).
- `state === Disputed` → ready to resolve (§7.3).

### 7.2 Raise a dispute on each Funded task

`disputeTask(taskId)` accepts the call from either `task.agent` or `task.worker` (see [contracts/CarbonEscrow.sol:141](../contracts/CarbonEscrow.sol#L141)). In a compromise scenario, **the worker should be the one calling**, because the agent address is the compromised one and you should not be using the old key further.

Two paths to get this done:

1. **Worker-initiated.** Send the worker the communication template in §9 with the task ID, the contract address, and a copy-pasteable `cast send` command they can run from a wallet they control:

   ```bash
   cast send [ESCROW_ADDRESS] "disputeTask(bytes32)" [TASK_ID] \
     --rpc-url $BASE_MAINNET_RPC_URL \
     --private-key $WORKER_KEY
   ```

2. **Old-key-initiated, if still safe.** If §4.1 is not yet complete and you judge it safe to use the old key one final time (the credential path may be revoked but the key itself has not signed anything malicious yet), the agent address can call `disputeTask` itself. This is faster but requires that you trust the compromised credential to behave for one more transaction. **Default: prefer worker-initiated.**

Either way, expect a `TaskDisputed(taskId, msg.sender)` event per call.

### 7.3 Resolve each disputed task to the worker

From the **new** owner, call `resolveDispute(taskId, true)`. `true` releases the full task amount to `task.worker` (see [contracts/CarbonEscrow.sol:171](../contracts/CarbonEscrow.sol#L171)).

```bash
# Once the new signer is wired into Vercel, the platform's own
# resolveDisputeOnChain() function in src/lib/contracts/signer.ts
# can drive this. For ad-hoc execution:

cast send [ESCROW_ADDRESS] \
  "resolveDispute(bytes32,bool)" [TASK_ID] true \
  --rpc-url $BASE_MAINNET_RPC_URL \
  --private-key $NEW_OWNER_KEY
```

Verify each release on Basescan: `task.worker` should receive `task.amount` USDC, and a `TaskResolved(taskId, true, amount)` event should be emitted.

### 7.4 Expired tasks

If any affected task has passed its `deadline`, **anyone** can call `expireTask(taskId)` to refund the original `task.agent` (the compromised address). This is generally undesirable during recovery — funds end up at the compromised address, which the new owner does not control.

If the agent address is a smart wallet you still control (e.g. a multisig), `expireTask` is fine. If it is a single-key EOA whose credential path is gone, **prefer the dispute path before the deadline elapses**. The recovery window is bounded by the soonest in-flight `task.deadline`.

---

## 8. Update Vercel and redeploy

The five GCP vars are non-sensitive metadata (no key material). Only `GCP_KMS_KEY_PATH` actually changes in a key-version rotation; the others change only if you moved to a new keyring/pool/service account in §5.1.

| Variable | Source | Notes |
|---|---|---|
| `GCP_KMS_KEY_PATH` | §5.2 output | Always changes on rotation. |
| `GCP_PROJECT_NUMBER` | `gcloud projects describe [PROJECT_ID]` | Changes only if new project. |
| `GCP_WORKLOAD_IDENTITY_POOL_ID` | `carbon-contractors-pool` | Changes only if new pool. |
| `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `vercel-runtime` | Changes only if new provider. |
| `GCP_SERVICE_ACCOUNT_EMAIL` | `kms-signer-svc@[PROJECT_ID].iam.gserviceaccount.com` | Changes only if new service account. |

The Zod schema in [src/lib/config.ts:36](../src/lib/config.ts#L36) treats all five as optional. The branching logic in [src/lib/contracts/signer.ts:49](../src/lib/contracts/signer.ts#L49) selects the KMS path when `GCP_KMS_KEY_PATH` is present.

After saving the new env vars in the Vercel dashboard:

1. Redeploy production.
2. Hit the production health endpoint and confirm `signer_using_kms` appears in logs with the new `keyPath`.
3. Issue a single low-value end-to-end test: create a task, fund it, complete it. Confirm USDC settles.

---

## 9. Communication template — to affected workers

Send this to each worker who has a Funded or Disputed task with the old agent address. Use whichever notification channel the contractor registered (see `notification_channels`).

> **Subject:** Carbon Contractors — action required to release escrow on task `[TASK_ID]`
>
> Hi,
>
> We are rotating our platform signer as a precaution. Your task `[TASK_ID]` was funded under the previous signer address, and the safest way to release your USDC is via our dispute path.
>
> **What we need you to do (one transaction):** call `disputeTask(bytes32)` on the escrow contract from your worker wallet.
>
> - Contract: `[ESCROW_ADDRESS]` on Base
> - Task ID: `[TASK_ID]`
>
> Copy-paste command (Foundry `cast`):
>
> ```
> cast send [ESCROW_ADDRESS] "disputeTask(bytes32)" [TASK_ID] \
>   --rpc-url https://mainnet.base.org --private-key <YOUR_KEY>
> ```
>
> Once you have called it, we will resolve the dispute in your favour and the full task amount will be released to your registered wallet `[WORKER_WALLET]`. Expected within 1 hour of your call.
>
> If you would prefer we walk you through this on a call, reply to this message.
>
> Thanks for your patience.
> Carbon Contractors

---

## 10. Post-incident

- **Re-pull HSM attestation.** A new key version means the previously-published attestation no longer covers the live signer. Run `gcloud kms keys versions get-public-key` for the new version and `gcloud kms keys versions describe --attestation-file=...` to capture the attestation. Replace or version-bump the artefacts in `docs/`: `carbon-contractors-escrow-signer-1.pub` (the public key) and `carbon-contractors-escrow-signer-1-CAVIUM_V2_COMPRESSED-attestation.dat` (the HSM attestation blob). The combined-chain `.pem` is regenerated from the same source.
- **Permanently destroy the disabled key version** only after a 30-day cooling-off period and only if forensic analysis is complete.
- **Audit log review.** Walk through every signing call in the GCP audit logs over the suspect window. Map each one to a corresponding application log line in Vercel. Investigate any unmatched entry.
- **Post-mortem.** Write a markdown post-mortem in `docs/incidents/[date]-[short-name].md` with timeline, root cause, response actions, and follow-ups.
- **Optional contract improvement.** AUD-010 notes a `completeTaskByOwner(taskId)` emergency function as a future contract-version improvement that would shorten this runbook substantially. Tracked under future contract redeploy work.

---

## Appendix A: Contract surface reference

This is the "if you forget everything else" cheat sheet. All references are against `contracts/CarbonEscrow.sol`.

| Function | Caller required | Required state | Effect |
|---|---|---|---|
| `createTask(taskId, worker, amount, deadline)` | anyone (becomes `task.agent`) | `None` | Pulls USDC from caller, sets `task.agent = msg.sender`, transitions to `Funded`. |
| `completeTask(taskId)` | `msg.sender == task.agent` | `Funded` | Releases `task.amount` to `task.worker`, transitions to `Completed`. |
| `disputeTask(taskId)` | `task.agent` **or** `task.worker` | `Funded` | Locks funds, transitions to `Disputed`. |
| `resolveDispute(taskId, releaseToWorker)` | `onlyOwner` | `Disputed` | Releases to `task.worker` (true) or refunds `task.agent` (false), transitions to `Resolved`. |
| `expireTask(taskId)` | anyone | `Funded` and `block.timestamp >= task.deadline` | Refunds `task.agent`, transitions to `Expired`. |
| `transferOwnership(newOwner)` | `onlyOwner` | n/a | Inherited from `Ownable`. Rotates `resolveDispute` authority. Does not change any existing `task.agent`. |

`TaskState` enum: `None=0, Funded=1, Completed=2, Disputed=3, Resolved=4, Expired=5`.

Events: `TaskCreated`, `TaskCompleted`, `TaskDisputed`, `TaskResolved`, `TaskExpired`.

---

## Appendix B: Five-line summary

If you only remember five things:

1. Revoke WIF impersonation first (`gcloud iam service-accounts remove-iam-policy-binding`).
2. Disable, do not destroy, the old KMS key version.
3. New key version → new derived address. Verify with `npm run verify:kms` before touching anything.
4. `transferOwnership(NEW)` on the escrow before doing anything else on-chain.
5. In-flight tasks: worker calls `disputeTask`, new owner calls `resolveDispute(taskId, true)`. Repeat per task.
