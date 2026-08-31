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
- **Three external facts are required and are not in this repository:** the EAS and SchemaRegistry
  addresses on Base and Base Sepolia, and the exact off-chain attestation EIP-712 envelope for the
  EAS version in use. `chain-constants.json` records them as `null` rather than guessed, and
  `scripts/audit/verify-eas-deployment.mjs` is how they get verified. **A wrong EAS address produces
  attestations to nowhere that look correct locally**, which is the same class of defect as a wrong
  USDC address.
- **The schema UID is derivable offline** and is pinned in `chain-constants.json`, so the registration
  transaction can be checked against an expected value rather than trusted.
- **No new dependency.** An off-chain EAS attestation is EIP-712 typed data, and this repo already
  signs EIP-712 through KMS (`src/lib/contracts/verdict.ts`). The EAS SDK would pull an ethers tree
  for an envelope we can encode ourselves, against a CI step that fails on high-severity advisories.
- **`Task.attestationUid` finally has a use.** It was reserved in `CC-082` for exactly this. Note it
  is written at `submitWork`, which is *before* completion — so it cannot hold a completion
  attestation's UID. It holds a reference the worker supplies at delivery, and the completion
  attestation is a separate object. Recorded because the field name invites the wrong assumption.

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
