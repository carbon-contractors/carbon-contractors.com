# ADR-0008 — Completion attestations: a signature the worker holds, not a transaction we send

- **Status:** proposed
- **Date:** 2026-08-31
- **Issue:** `CC-036` (P0)
- **Depends on:** `ADR-0001` (A1.1, D5, D9), `ADR-0002` (D4, D9), `ADR-0004` (D4–D6), `ADR-0006` (D7)

## Context

`CC-036` has been open since 2026-07-25 and P0 since 2026-08-10. It says: *"On-chain attestation per
completed task, surfaced on the worker's reputation… Attestations are what make the reputation claim
in the README actually true."*

What exists today: reputation is computed from `CarbonEscrow` event logs, with a DB fallback
(`src/lib/reputation/index.ts`). `Task` already carries an unused `bytes32 attestationUid`, accepted
by `submitWork` and echoed on `WorkSubmitted` — the slot `ADR-0001` reserved so that shipping EAS
would not need a second contract deployment.

**The ticket's own justification partly expired, and the 2026-08-11 triage note says so.** The
homepage no longer claims a formal attestation; it says "a permanent onchain record", which is true
via event logs. So the question this ADR has to answer first is not *how* but **what EAS actually buys
over what already works.**

### What it buys

1. **A schema a third party can read without knowing our ABI.** The pitch is agents discovering
   humans. An agent should not have to learn `CarbonEscrow`'s event signatures to evaluate a worker.
2. **Portability across redeploys — the strong one.** Escrow events live at a contract *address*. We
   have redeployed once (`CC-082`) and `CC-034` is a third deployment. A worker's history therefore
   fragments across addresses, and reconstructing it requires knowing every address we have ever
   used. That is a real defect in "the reputation is yours", and it is not fixable by better event
   queries.
3. **Composability.** Other EAS consumers could build on it. Speculative; listed for honesty, not
   weight.

Point 2 is the one that justifies the work. Points 1 and 3 would not, on their own.

### What constrains it

- **`ADR-0001` A1.1 removed platform transactions from settlement.** *"The platform therefore makes no
  transaction in any settlement path — no gas, no nonce management, no signer liveness between a
  worker and their money."* Whatever this ADR decides must not put that back.
- **`ADR-0001` D5 requires re-runnability.** A verdict must stay checkable years later, which is why
  `checkerHash` is pinned into every verdict.
- **`ADR-0002` D4 deletes task content on a retention schedule** (`CC-087`). An attestation is
  permanent. Anything task-content-bearing in it outlives the deletion and makes a published privacy
  claim untrue.
- **`ADR-0004` D4–D6: pseudonymous, never anonymous.** An attestation permanently and publicly binds
  a wallet to a body of work.

## Decision

### D1 — The attestation is a signature, not a transaction

The platform signs an **off-chain EAS attestation** with the existing verdict-signing key and hands
it to the worker. The platform sends no transaction.

This is not a new architecture. It is the move `ADR-0001` Amendment 1 A1.1 already made for verdicts,
applied one step later, and the reasoning transfers unchanged:

> *"There is deliberately no `postVerdict` function. A verdict is signed off-chain by an accepted
> signer and handed to the parties; whoever acts presents the signature."*

**Rejected: the platform sends an on-chain `attest()` per completion.** It reintroduces exactly what
A1.1 removed. Not into the settlement path — the money has already moved, so a missing attestation
delays a reputation entry rather than a payment — but into a per-task obligation the platform must be
alive and funded to meet. It also fails *silently*: a worker whose attestation never landed has a gap
in their record and no signal that it happened. And it is a permanent per-task gas cost on a platform
whose tasks may be worth $5.

**Rejected: the worker self-attests.** An attestation you issue about yourself carries no
information.

### D2 — The worker may register it on-chain, and pays for that themselves

An off-chain attestation is verifiable by anyone holding it, but **not discoverable**. That is a real
loss and D1 does not pretend otherwise.

So the worker can register their attestation on-chain through EAS whenever they want permanence and
discoverability, paying their own gas. Same pull-payment principle as `releaseAfterReview`: the
motivated party acts, and the platform is not in the path.

This is also the `ADR-0006` D7 answer for reputation. If the platform disappears, off-chain
attestations held only by the platform disappear with it — so **the durable copy must be in the hands
of the person whose reputation it is**, not ours. Handing the worker their signed attestation at
completion is what makes their history survive us.

### D3 — The attester is the existing verdict signer

No new key, no new trust root. The verdict signer already signs what the deterministic checker found;
attesting to a completion it can read off-chain is strictly less authority than that.

It follows that `ADR-0001` D9's v2 path — permissionless verdicts against a bond — extends to
attestations for free, because both are "a signature from an accepted signer" rather than a privileged
transaction.

### D4 — The schema carries hashes and public facts only

```
bytes32 taskId, address escrow, uint256 chainId, address agent, uint256 amountUsdc,
uint8 route, uint64 completedAt, bytes32 specHash, bytes32 evidenceHash,
bytes32 verdictHash, bytes32 checkerHash
```

The worker is the EAS `recipient`, not a schema field — that is where EAS puts the subject, and
duplicating it invites the two disagreeing.

Every field earns its place:

| Field | Why |
| :-- | :-- |
| `taskId` | look the task up on the escrow |
| `escrow`, `chainId` | **the portability fix.** Without these the attestation is meaningless after a redeploy, which is the entire argument for doing this at all |
| `agent` | who hired; already public on-chain |
| `amountUsdc` | volume weighting, 6dp units as the contract stores it |
| `route` | `CompletionRoute` — see D5 |
| `completedAt` | recency weighting |
| `specHash`, `evidenceHash`, `checkerHash` | `ADR-0001` D5 re-runnability: a third party can re-run the check years later and get the same answer |
| `verdictHash` | links the verdict where one existed |

**Nothing task-content-bearing.** No description, no evidence bytes, no payload. The attestation
therefore survives retention deletion without contradicting `ADR-0002` D4 — the hashes stay
meaningful as commitments even once the content behind them is gone.

**The schema UID is permanent.** It is `keccak256(abi.encodePacked(schema, resolver, revocable))`, so
changing any field means a new schema and a fork in the reputation history. That is the reason this
is an ADR and not a commit.

### D5 — `route` is included, and it cuts both ways

`route` records *how* the task completed: the agent confirmed, the review window elapsed, a passing
verdict was presented, or the arbitration timed out.

This is deliberately unflattering in places. "Review elapsed" is weaker evidence of quality than
"passing verdict" — it means nobody checked. Including it makes reputation honest in both directions,
which is `CC-075`'s concern from the other side: distinguishing "the worker went AWOL" from "the agent
would not accept" requires the record to say which happened.

A reputation score that cannot distinguish a checked pass from a clock running out is a score that
rewards silence.

## The privacy consequence, stated rather than buried

**An attestation is permanent, public, and un-deletable, and it is the feature being sold as a
benefit.** Three things follow, and none of them is a reason not to do it:

1. **Pseudonymity degrades with volume.** One attestation says little. Two hundred on one wallet is a
   pattern — categories, rates, working hours, task cadence. `ADR-0004` D4 says *pseudonymous*, never
   anonymous, and this is one of the mechanisms by which that distinction earns its keep.
2. **Registration must be the worker's choice, not ours.** D2 is not only an architectural preference.
   The party who bears the permanence should be the party who elects it. A platform that registered
   attestations automatically would be making an irreversible privacy decision on someone else's
   behalf, at no cost to itself.
3. **This needs saying in `/learn`, not only here.** A worker choosing to register should understand
   they are publishing a permanent record. That is a copy change, and it belongs with `CC-036`'s
   closing scope alongside removing the caveat sentence in `module-3-how-x402-pays-you.md`.

## Consequences

- **`CC-036` cannot close on this ADR alone.** Closing needs: the schema registered on-chain (one
  transaction, per network), the addresses verified rather than assumed, the worker-facing handover,
  and the two copy changes above.
- ~~**Three external facts are required and are not in this repository:** the EAS and
  SchemaRegistry addresses on Base and Base Sepolia, and the exact off-chain attestation EIP-712
  envelope for the EAS version in use.~~ **Superseded by A1** the same day. Both addresses are
  verified and recorded; the envelope is a **view function**, so it is read at runtime and not
  transcribed at all. **A wrong EAS address produces attestations to nowhere that look correct
  locally**, which is the same class of defect as a wrong USDC address — hence
  `scripts/audit/verify-eas-deployment.mjs` rather than trust.
- **The schema UID is derivable offline** and is pinned in `chain-constants.json`, so the registration
  transaction can be checked against an expected value rather than trusted.
- **No new dependency.** An off-chain EAS attestation is EIP-712 typed data, and this repo already
  signs EIP-712 through KMS (`src/lib/contracts/verdict.ts`). The EAS SDK would pull an ethers tree
  for an envelope we can encode ourselves, against a CI step that fails on high-severity advisories.
- **`Task.attestationUid` finally has a use.** It was reserved in `CC-082` for exactly this. Note it
  is written at `submitWork`, which is *before* completion — so it cannot hold a completion
  attestation's UID. It holds a reference the worker supplies at delivery, and the completion
  attestation is a separate object. Recorded because the field name invites the wrong assumption.

## Amendment 1 — 2026-08-31 — the envelope is chain-readable, and it differs per network

Written the same day as the ADR, because measuring the deployment answered a question the
Consequences section had recorded as unanswerable.

### A1.1 — Both addresses are verified, and they are predeploys

`verify-eas-deployment.mjs`, against both chains:

| | EAS | SchemaRegistry | `version()` |
| :-- | :-- | :-- | :-- |
| base-sepolia | `0x4200…0021` | `0x4200…0020` | **1.2.0** |
| base-mainnet | `0x4200…0021` | `0x4200…0020` | **1.0.1** |

They are **OP Stack predeploys**, same addresses on both networks, behind EIP-1967 proxies
(Base Sepolia's implementation slot reads `0xc0d3c0d3…0021`). Two things follow:

- **The implementation behind each address differs per network and can be upgraded by the
  chain operator.** That is a trust assumption our attestations inherit, and it is not one we
  can remove. Recorded rather than discovered later.
- **Selector-scanning the bytecode does not work here.** The proxy is ~2KB and carries no
  dispatcher, so the technique `verify-escrow-deployment.mjs` uses for
  `releaseAfterArbitration` finds nothing. That check works only because `CarbonEscrow` is
  not proxied.

**A trap worth naming.** EAS's documentation has a page headed **"Sepolia"** — that is
Ethereum L1 (chain 11155111), *not* Base Sepolia (84532). Its EAS address has **no bytecode**
on Base Sepolia, confirmed. The two read as interchangeable in a docs sidebar and are entirely
different chains; pasting the wrong one in would have produced attestations referencing
nothing.

### A1.2 — The EIP-712 envelope must be read from the chain, never hard-coded

The Consequences section listed *"the exact off-chain attestation EIP-712 envelope"* among
facts "not in this repository", to be transcribed from documentation. **That was wrong in a
useful direction: it does not need transcribing at all.** EAS exposes both halves as view
functions.

```
                       base-sepolia (1.2.0)   base-mainnet (1.0.1)
getDomainSeparator()   0x64d609c0…ac68        0x441f04bd…954b
getAttestTypeHash()    0xf83bb2b0…3d3f        0xdbfdf8dc…de61
```

**They differ.** So the envelope is not one fact, it is a per-network fact, and a build that
hard-codes it signs correctly on one network and produces signatures the other rejects. The
failure would surface at the mainnet migration, on the first attestation, and would look like
a signing bug rather than a version skew.

So: **read `getDomainSeparator()` and `getAttestTypeHash()` at signing time.** The values in
`chain-constants.json` are for cross-checking, not embedding, and
`chain-constants.test.ts` asserts the two networks' values stay different — pinned because
the addresses being identical makes collapsing them look like a tidy-up.

### A1.3 — D2's mechanism is delegated attestation

D2 said the worker "registers it on-chain" without saying how, which under-specified it: you
cannot hand an off-chain attestation to EAS and have it stored. The mechanism is
**`attestByDelegation`** — the attester signs the EIP-712 request, and *anyone* may submit it.
`getAttestTypeHash()` exists precisely to support that, and its presence on both networks is
the evidence the path is available.

This is better than D2 as originally written, because the on-chain `attester` field ends up
being the platform's verdict signer while the *transaction* is the worker's. "The platform
attested, the worker published" is recorded on-chain rather than merely intended — and the
platform still sends nothing, which is D1.

### A1.4 — `EAS.attestByDelegation`, not the `EIP712Proxy`

EAS ships an `EIP712Proxy` alongside it, and finding its address in the same docs table makes it
look like the natural home for a signature-based flow. It is not the one to use here.

**It carries its own envelope**, measured 2026-08-31:

| | EAS | EIP712Proxy |
| :-- | :-- | :-- |
| base-sepolia | `0xf83bb2b0…3d3f` (1.2.0) | `0xea02ffba…1af1` (**1.3.0**) |
| base-mainnet | `0xdbfdf8dc…de61` (1.0.1) | `0x9d3e80e7…4567` (1.2.0) |

Four typehashes across two networks, all distinct, and signing against any wrong one produces a
signature the target rejects. `chain-constants.test.ts` asserts they stay four values.

**Rejected because the proxy would become the on-chain `attester`.** Both proxies report
`getEAS()` → the EAS predeploy, so they call EAS on the submitter's behalf — which means the
attestation would read *"attested by `0xAd64…`"*, shared infrastructure used by everyone on the
chain, and recovering our verdict signer's identity would depend on the proxy's own bookkeeping
rather than on the attestation.

`attestByDelegation` preserves the original attester. That is exactly the property A1.3 needs:
the on-chain record says the platform attested and the worker paid to publish it, without the
platform transacting.

**One assumption, and it gets a test rather than a footnote.** That `attestByDelegation` records
the *signer* as `attester` is design knowledge, not something measured here — confirming it needs
a real attestation on chain. So the first one submitted after registration must be read back:

```
getAttestation(uid).attester == the verdict signer, not the submitter, not a proxy
```

If it comes back as the worker's address, A1.3's central claim is wrong and D2 needs rethinking
before anything is published. Added to `CC-036`.

*Unresolved, and minor: the Indexer answered `version()` and `getEAS()` on Base Sepolia and
neither on Base mainnet, at identical bytecode length. Probably public-RPC rate limiting rather
than a real difference. Nothing here depends on the Indexer, so it is noted and not chased.*

## Amendment 2 — 2026-10-19 — the attester's nonce is a queue, so nothing is pre-signed

Written before any signing code. `CC-036`'s next box was "sign a delegated attestation", and the
first question about building it — *when* does the platform sign? — turned out to have a wrong
answer that A1.3 implied.

### A2.1 — Measured: both versions spend one shared, sequential nonce per attester

Read from the verified implementation source behind `0x4200…0021`, 2026-10-19 (Basescan):

| | Implementation | Nonce in the signed hash | `deadline` | `increaseNonce` |
| :-- | :-- | :-- | :-- | :-- |
| base-sepolia | `0xc0d3…0021`, EAS **1.2.0** | `_nonces[request.attester]++` | yes | yes |
| base-mainnet | `0xbeb5…06ed`, EAS **1.0.1** | `nonce = _nonces[request.attester]++` | **no** | **no** |

A delegated request verifies only against the attester's *current* nonce. Every request our verdict
signer issues shares one counter, so requests can only land **in nonce order**, one at a time.

### A2.2 — Consequence: pre-signing at completion would deadlock on mainnet

A1.3 read naturally as "sign at completion and hand the worker the request". With a shared
sequential nonce that fails:

- Worker A completes and gets a request at nonce *N*. Worker B completes and gets *N+1*.
- B's request is unusable until A's is submitted. D2 makes submission optional, so A may never
  submit.
- On **1.0.1 nothing clears it**: there is no `deadline` to expire A's request and no
  `increaseNonce` to skip past it. The only way out is for someone to submit A's request, and if
  that someone is the platform, D1 is gone.

So one worker who simply declined to publish would block every later worker's publication. It would
show up as B's submission reverting `InvalidSignature`, which looks like a signing bug.

### A2.3 — Decision: durability and discoverability come from different objects

**At completion the worker gets an off-chain EAS attestation.** This is D1 as originally written: an
EIP-712 signature over the attestation itself. It carries no nonce, never expires, and is
verifiable by anyone forever. It is the durable copy `ADR-0006` D7 requires, and it is what survives
us.

**On-chain registration is signed on demand, at the current nonce, and never queued.** When a worker
asks to publish, the platform reads `getNonce(attester)`, signs one delegated request for that
attestation, and hands it back for immediate submission. Properties:

- **An unsubmitted request blocks nobody.** It does not advance the nonce, so the next request is
  signed at the same *N*. A stale request is harmless: if submitted it publishes a true attestation
  for its own worker, and if not it is overtaken.
- **A race costs a retry, not a loss.** Two workers signed at *N* concurrently: the first submission
  wins and the second reverts. The second re-requests and gets *N+1*. The worker's gas on the
  reverted transaction is the cost, so the endpoint should say "submit now", and the 1.2.0 `deadline`
  stays short (`ATTESTATION_REQUEST_VALIDITY_SECONDS`, one hour).
- **The platform still transacts nowhere.** It signs twice, once off-chain at completion and once
  on request. It never submits, and never calls `increaseNonce`.

### A2.4 — If the platform is gone, the worker can still anchor it

Delegated registration needs a live platform to sign at the current nonce, so it cannot be the
durability story. The off-chain attestation is. Both versions also expose
`timestamp(bytes32 data)`: anyone can call it, it records `block.timestamp` against a value once,
and it reverts `AlreadyTimestamped` on a repeat. A worker can timestamp their attestation's UID
on-chain at their own cost, with no platform involvement. The UID is the anchor and the off-chain
signature still proves the attester. Weaker discoverability than a full on-chain attestation, but it
needs nobody's permission. That is the `ADR-0006` D7 property.

### A2.5 — Rejected

- **Pre-sign at completion (A1.3's natural reading).** A2.2.
- **Platform submits, or batches, the attestations.** It removes the queue by putting the platform
  in the transaction path, which D1 exists to prevent. It is also a recurring gas cost under
  `ADR-0013` D2's no-fee position.
- **Clear stuck nonces with `increaseNonce`.** Absent on mainnet, and a platform transaction where
  it exists.
- **One attester key per worker, or a pool of keys.** It parallelises nonces at the cost of many trust
  roots, against D3's "no new key". Revisit only if A2.3's retry rate is measured to matter.
- **`EIP712Proxy`.** Already rejected in A1.4. It also does not remove the nonce.

### A2.6 — What this changes in `CC-036`

- "Sign a delegated attestation" becomes two signing paths: an **off-chain attestation at
  completion** and a **delegated request on demand**. Each has a test that reads the nonce at
  signing time and never caches it.
- **New measurement, same shape as A1.2.** The off-chain attestation has its own EIP-712 type,
  distinct from the delegated `Attest`, and EAS has changed it across versions. Read or derive it per
  network before signing; never transcribe it. **Done 2026-10-19, A2.7.**
- **The read-back check in A1.4 still stands**, and now also covers the off-chain path. The recovered
  signer must be the verdict signer.
- **Never call `revokeOffchain`.** Both versions have it, and it would let the platform mark its own
  off-chain attestations revoked. That is the lever over a worker's history which the open
  "non-revocable" item argues against.

### A2.7 — Measured: the off-chain envelope, and where it actually lives

**It is not in the contract.** Both EAS implementations were searched (A2.1's sources). They know
nothing about off-chain attestations except `timestamp(uid)` and `revokeOffchain(uid)`, which take
an opaque UID. The format is defined by the EAS SDK, read from
`@ethereum-attestation-service/eas-sdk` 2.10.0 (`dist/lib.esm/offchain/offchain.js`, read
2026-10-19, not installed). A2.6 assumed the struct would vary by contract version. It does not:
the SDK versions it separately (Legacy, 1, 2) and signs with **Version 2** whatever the contract
version is.

| | Value |
| :-- | :-- |
| Domain name | `EAS Attestation` (not `EAS`, which is the delegated domain) |
| Domain version | the contract's `version()`: `1.2.0` Sepolia, `1.0.1` mainnet |
| Type | `Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)` |
| Typehash | `0x258b757f…1132`, the same on both networks |
| Domain separator, base-sepolia | `0x624018bb…94be` |
| Domain separator, base-mainnet | `0x21736c2b…89ec` |

So only the domain differs per network. The struct does not.

**How far to trust a derived value.** There is no chain value to read here, so these are derived.
The method is checked against the chain. The same derivation with the name `EAS` reproduces the
delegated `domainSeparator` that A1.2 *read* from both chains, exactly.
`chain-constants.test.ts` repeats both derivations, and fails when one recorded value is
corrupted. If the method check ever breaks, the off-chain values are wrong too.

**A trap for the verifier.** The SDK's UID is
`solidityPackedKeccak256(['uint16','bytes','address','address','uint64','uint64','bool','bytes32','bytes','bytes32','uint32'], …)`,
and its `bytes` schema argument is `hexlify(toUtf8Bytes(schema))`: the schema UID's 66-character
**hex string as UTF-8**, not its 32 raw bytes. A verifier that passes the bytes32 computes a
different UID. It then rejects every genuine attestation, and the failure looks like a bad
signature. Our signer must reproduce the SDK's UID exactly, and a test must pin it against an
SDK-produced vector before anything is handed to a worker.

**Salt.** Version 2 adds a random 32-byte `salt`, so two attestations with identical content get
different UIDs. That matters to us: `completedAt` aside, two completions can encode the same data,
and without a salt they would collide on `timestamp(uid)` (`AlreadyTimestamped`).

Recorded in `chain-constants.json` → `protocol.attestations.offchainEnvelope`.

## Amendment 3 — 2026-10-20 — signing at completion (proposed)

Written with the first signing code, `src/lib/attestation/completion.ts` and
`GET /api/attestation/completion`. Four calls had to be made that D1–D5 and A2 left open.

### A3.1 — Two more `route` values

D5 listed four routes. The contract has five, and a sixth way to pay a worker:

| Value | Name | Source |
| :-- | :-- | :-- |
| 0–3 | as D5 | `TaskCompleted.route` |
| 4 | `OwnerEmergency` | `TaskCompleted.route`: `completeTaskByOwner` (CC-049), the agent's key lost after delivery |
| 5 | `ArbitrationRuling` | **Not a contract value.** `TaskResolved(releasedToWorker = true)`: the owner ruled for the worker, and the contract records no route |

`5` is numbered past the contract's enum so the two cannot collide. `schema.test.ts` reads the enum
from `CarbonEscrow.sol` and fails if the contract ever gains a value at that index. `route` is a
`uint8` in the registered schema, so neither value changes the schema UID. An unknown route from
the chain makes the signer refuse rather than attest a number whose meaning is unwritten.

A ruling for the **agent** is not a completion and is never attested.

### A3.2 — One completion, one attestation, with nothing stored

A2.7 noted the SDK draws a random `salt`. That would let a worker mint a fresh attestation for the
same job each time they asked. Instead:

- `salt = keccak256(abi.encode("carbon-contractors/CC-036/completion/v1", chainId, escrow, taskId))`;
- `time` = the timestamp of the block that paid out, read from the chain;
- every data field comes from the escrow: the worker, agent and hashes from `getTask`, the route
  and amount from the payout event.

So signing the same completion again produces the same message and the same UID. No table, no
migration, and nothing to keep in sync. A repeated request is just another valid signature over
one attestation. The salt stays unique per (chain, escrow, task), which is all A2.7 needed it for.

### A3.3 — `checkerHash` is not recoverable, so it is pinned with a tripwire

A verdict's `checkerHash` lives only inside its EIP-712 digest, which cannot be inverted. Verdicts
are not persisted, and a smart-wallet `claimWithVerdict` arrives wrapped in an ERC-4337 bundle, so
calldata decoding is not a dependable source either. Only `CHECKER_RULE_VERSION = 1` has ever
existed, so for any non-zero `verdictHash` the value is exactly `getCheckerHash(1)`.
`checkerHashFor` **throws** once a second rule version exists. At that point verdicts must persist
their `checkerHash` (a migration) before completions can be attested again. This is a deliberate
stop, not a silent guess.

### A3.4 — Surface and checks

- **`GET /api/attestation/completion?payment_request_id=…`** is worker-only. The worker is judged
  against the on-chain `worker`, never the DB (`CC-037`), and before anything is signed. Auth is
  the same two routes as `/api/verdict`: the session, or challenge headers. Responses: 409 when the
  task has not paid its worker, 403 for anyone else.
- **Before signing**, EAS `version()` is read and proven: the delegated domain built from it must
  reproduce the chain's `getDomainSeparator()`, or the signer refuses. The off-chain domain is then
  built from the proven version.
- **The response is the EAS SDK's `{ sig, signer }` share shape**, so EAS tooling can verify or
  import it. bigints are decimal strings.

Still open: the delegated on-chain request (A2.3), the first real signature on Sepolia, and the
A1.4 read-back. The dashboard and MCP surfaces are open too; this amendment builds the API only.

### A3.5 — The delegated publish request (2026-10-21)

`src/lib/attestation/delegated.ts` and `POST /api/attestation/publish` build A2.3's on-demand path.

- **The same record as the off-chain copy.** `completionRecord` and `completionRecipient` are
  shared, so a published attestation and the worker's off-chain copy cannot describe one
  completion differently.
- **The struct is read, not assumed.** `getAttestTypeHash()` is resolved through `envelope.ts`,
  which refuses an unknown typehash and names the `EIP712Proxy`'s. The domain built from
  `version()` must reproduce `getDomainSeparator()`. An unknown struct returns 503 with nothing
  signed.
- **The calldata matches each network's struct**, read from the deployed source on 2026-10-21:

  | | `DelegatedAttestationRequest` ends | Signed hash |
  | :-- | :-- | :-- |
  | base-sepolia, 1.2.0 | `…, address attester, uint64 deadline` | includes `value` and `deadline` |
  | base-mainnet, 1.0.1 | `…, address attester` | neither |

  Both carry `value` in `AttestationRequestData`, and it must be 0 because the resolver is
  `address(0)`. The two give different selectors, so a request built for one network cannot be
  sent to the other.
- **1.0.1 verifies with `ECDSA.recover`**, not `SignatureChecker`. On mainnet the attester must be
  an EOA. Our KMS/HSM signer is one, but a move to a contract-wallet attester would break
  mainnet publishing silently. That is worth knowing at `CC-090`, when the verdict signer gets its
  own key.
- **Tested against EAS's own hash.** `delegated.test.ts` rebuilds `_verifyAttest`'s digest for
  each version from the transcribed source, without viem's typed-data path, and recovers the
  attester from the calldata's own signature.

**Not prevented: publishing twice.** Each request is signed at a fresh nonce. A worker who
submits two produces two on-chain attestations of one completion. The `taskId`, `escrow` and
`chainId` in the data make them trivially deduplicable. Preventing it would need an EAS log scan
per request. So reputation readers must count by `(chainId, escrow, taskId)`, never by
attestation. Recorded here so the reader is written that way.

## Open items

- **Which network registers the schema first.** Sepolia, obviously, but the UID is derived from the
  schema string and resolver, so the same UID appears on both networks only if both use the same
  resolver — `address(0)` here, so they will match. Worth verifying rather than assuming.
- **Whether the attestation should be revocable.** Currently proposed as **non-revocable**: a
  completion happened or it did not, and a revocable reputation record hands the platform a lever
  over a worker's history that `ADR-0001` D9 would not otherwise grant it. The counter-argument is
  fraud discovered after the fact. Unresolved; non-revocable is the safer default and the one that
  matches "the reputation is yours".
- **Whether `get_reputation` should serve attestations.** It would make them discoverable through us,
  which is convenient and re-centralises the thing D2 decentralised. Probably yes, clearly marked as
  a convenience rather than the source of truth.

Related: `CC-036`, `CC-082`, `CC-044`, `ADR-0001` A1.1/D5/D9, `ADR-0002` D4/D9, `ADR-0004` D4–D6,
`ADR-0006` D7, `src/lib/contracts/verdict.ts`.
