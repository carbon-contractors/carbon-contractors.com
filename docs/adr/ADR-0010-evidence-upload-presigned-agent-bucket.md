# ADR-0010 — Evidence upload: pre-signed writes into the agent's bucket, not platform storage

- **Status:** proposed
- **Date:** 2026-09-03
- **Issue:** `NOR-334` (Linear; split from `NOR-327`), backlog `CC-101`
- **Depends on:** `ADR-0001` (D4, D5), `ADR-0002` (D2.2, D3, D4, D5, D9), `ADR-0003` (D2), `ADR-0009` (worker sessions)
- **Deciders:** Aaron Clifft (pending)

## Context

`NOR-327` shipped the structured evidence form (PR #185): a worker can declare artefacts with zero
JSON. But each artefact still needs a **hosted URI**, and today the only path is worker-hosted
files — which a worker in a car yard with a phone cannot do. `NOR-334` asks for an upload flow that
produces the URI, and names four design decisions to settle before build: storage choice, retention
interplay, hash binding, and size/type limits (plus whether `phash` can move platform-side).

The doctrine already answers most of it, and the answer is directional:

- `ADR-0002` D3 — **the platform is not in the data path.** Evidence is written to a bucket the
  hiring agent nominates; the checker reads a time-limited URL and retains nothing; the platform
  persists `evidenceHash` and `verdictHash` only.
- `ADR-0002` D2.2 — the **published claim**: *"The platform stores no task evidence and retains no
  task content after settlement."* Explicitly gated on D3 and D4 shipping as specified.
- `ADR-0002` D9 — verifiable deletion, and the three traps (backups/PITR, MVCC, logs).
- `ADR-0002` D5 — any feature needing durable task content is a **design smell**.
- `src/lib/spec/schema.ts` already carries `evidence_bucket {provider: s3|gcs|https, target}`,
  documented "optional until CC-083's evidence path exists", with the comment *the platform never
  holds the bytes*. This ADR is what makes that field usable.

So "platform-hosted bucket" is not a neutral convenience feature. It amends an accepted ADR,
rewrites a public claim, and changes the platform's regulatory posture. This ADR treats that as the
alternative to be rejected, and proposes the mechanism that keeps every accepted decision intact.

## Decision (proposed)

### D1 — The platform still never holds evidence bytes (reaffirm D3; reject platform storage)

Platform-hosted storage (Supabase Storage or a platform-owned S3 bucket) is **rejected** as the
upload destination:

1. It falsifies the D2.2 public claim, or forces that claim to be rewritten before launch — a
   product decision, not an implementation detail.
2. It makes the platform the controller of worker-captured imagery — car-yard photos routinely
   contain third parties. `ADR-0002` D8 names serious invasion of privacy (statutory tort, no
   turnover exemption) as the highest-weighted regulatory risk; D3 and D4 are its mitigations.
3. It imports D9's three deletion traps into object storage, where "provably gone" is *weaker* than
   in Postgres (versioned buckets, replication, CDN caches).
4. It creates durable task content, which D5 flags as a design smell to resolve against the event
   log.

Consequence: no `ADR-0002` amendment is needed, no claim is rewritten, and the platform's evidence
history never becomes a breach surface — because it does not exist.

### D2 — Pre-signed direct uploads into the agent's nominated bucket

The platform never touches bytes: the worker's browser uploads **directly** to the agent's bucket
via a short-TTL pre-signed PUT that the platform mints.

- **Nomination:** the agent sets `evidence_bucket` at task creation (field exists in
  `AcceptanceSpecV1`). Nomination is consent for the platform to mint *upload grants* against that
  bucket — nothing more.
- **Credential model** (the open question `NOR-334` flagged): the agent supplies a **scoped,
  write-only upload credential at task-creation time**, as a `createTask` parameter **outside the
  acceptance spec** — credentials are transport metadata and must never enter the spec preimage
  that `specHash` pins. Scope: `PutObject` only, under a per-task prefix (`tasks/<taskId>/`), no
  `List`, no `Delete`. Platform stores it KMS-envelope-encrypted (precedent:
  `src/lib/contracts/kms-signer.ts`) in an unbacked ephemeral table, excluded from PITR — the
  migration-019 pattern.
- **Flow:** authenticated worker session (`ADR-0009`) → `POST /api/evidence/upload-url`
  `{taskId, filename, contentType}` → platform validates (worker assigned, task active, content-type
  allowlist, size cap) → returns pre-signed PUT, TTL ≤ 10 minutes, one artefact per URL → browser
  PUTs the bytes to the bucket → worker submits the resulting URI into the evidence form's existing
  artefact field.
- **Providers:** `s3` (including S3-compatible: R2, MinIO) and `gcs` via signed URLs. The `https`
  provider remains worker-self-hosted as today — the platform cannot presign into an arbitrary web
  host. Nobody is locked out; some workers just don't get the convenience.

### D3 — Retention: the grant dies with the task; the bytes were never ours

- The credential row and any upload metadata live in the ephemeral task-content store, purged on
  the migration-019 clock, with a `task_content_deletion_log` entry. The grant itself can die at
  terminal state — earlier than the evidence-URL field, which D4 holds until verdict-posted.
- **No byte-deletion claim is made or needed** — the platform never held them. Bucket-side lifecycle
  is the agent's business; `ADR-0002` D7's task-creation notice should tell agents to configure
  their own lifecycle rules.

### D4 — Hash binding: URIs are part of the preimage, frozen at bundle submission

`CC-084`: the `evidenceHash` preimage is the agent's verbatim bundle string, artefact URIs included.
The upload flow therefore runs **before** bundle submission; once submitted, URIs are immutable.
The upload endpoint never rewrites or canonicalises a URI — the form receives exactly the URI the
upload produced. Any silent rewrite after submission would break on-chain verification of the
bundle.

### D5 — Limits, phash, and abuse

- **`phash` stays checker-side.** Platform-side computation at upload would require the platform to
  read the bytes — breaching D1 — and cache derived content. Per `CC-083`, perceptual-hash
  comparison already runs in the checker from its time-limited URL, so nothing is lost. If the
  current form asks workers to compute `phash` themselves, that requirement should be removed as
  part of implementation — it is the "hardest form field" for exactly the worker this ticket serves.
- **Coarse gate at the endpoint, binding criterion in the checker.** Content-type allowlist
  (jpeg/png/heic/webp/pdf), size cap per artefact (platform maximum, agent-configurable downward),
  artefact count already enforced by the checker as a spec criterion.
- **Abuse:** a worker can upload junk into an agent's bucket. Mitigations: per-task prefix
  isolation, write-only-no-delete credentials (an upload cannot overwrite or destroy other
  objects), size caps, and the existing consequence machinery — junk evidence fails the verdict and
  costs stake (`ADR-0001` D8). The bucket credential never grants read, list, or delete.

## Consequences

- **+** Privacy posture fully intact: no ADR amendment, no public-claim rewrite, no new regulator
  surface, no evidence breach surface on the platform at all.
- **+** Workers need zero hosting; the phone-camera path is a direct browser PUT.
- **+** The agent remains controller in fact; the platform remains a hash-keeper and a
  grant-minter.
- **−** Agent onboarding gains a real step (create bucket, mint scoped credential, pass it at
  `createTask`). Measured against the `NOR-333` lens: this is one-time agent-side setup, not
  per-task latency — and it is the price of the agent controlling its own evidence. Mitigate with a
  documented console/Terraform recipe and a `request_human_work` acceptance test.
- **−** Agents without any cloud account cannot use artefact-evidence tasks. `evidence_bucket`
  stays optional in the schema; categories that need no artefacts are unaffected.

## Alternatives considered

- **Platform Supabase Storage bucket.** Rejected — D1 items 1–4. If a "concierge hosting" tier is
  ever wanted as a product, that is a new ADR amending `ADR-0002` and rewriting the public claims,
  not a silent add.
- **Platform-relayed upload** (worker → platform → agent bucket). Rejected: the platform is in the
  byte path transiently, which drags the D9 scratch-copy rules along for zero benefit over
  pre-signed direct upload.
- **IPFS / content-addressed storage.** Rejected for v1: persistence guarantees are economic, not
  contractual, and immutable public content breaks the D6 erasure pattern (deleting the preimage
  satisfies erasure precisely because the platform controls no other copy — a pinned IPFS copy is a
  copy the erasure story cannot reach).
- **Status quo** (worker self-hosts). Rejected — this is the gap `NOR-334` exists to close.

## Open items (for the PO)

1. **Ratify D1** — this forecloses platform-hosted evidence as a product option. Everything else
   follows from it.
2. Agent onboarding UX ownership: who writes the bucket-setup recipe, and does
   `request_human_work` validation warn when `evidence_bucket` is absent but criteria require
   artefacts?
3. Confirm the cap values (platform max artefact size; default TTL) at implementation time.

## Implementation sketch (post-acceptance, not in this ADR's scope)

Migration `024_task_upload_credentials` (ephemeral, unbacked, RLS deny-all, deletion-logged) ·
KMS envelope helper · `POST /api/evidence/upload-url` (worker-session auth) · upload widget wired
into the `NOR-327` form · `createTask` credential parameter (outside the spec preimage) ·
form-side removal of the worker-computed `phash` requirement if present.
