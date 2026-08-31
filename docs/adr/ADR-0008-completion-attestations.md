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
