# Runbook — redeploying CarbonEscrow

**What this is for:** replacing the live `CarbonEscrow` with a new deployment, on Sepolia or on
mainnet. Every step that has gone wrong before is called out; nothing here is theoretical.

**Why it needs a runbook at all.** A redeploy is not one action. It is a contract deployment, an
ownership transfer, two environment variables, a Vercel rebuild, a constants file, and a set of
orphaned tasks on the old address — and **six of those seven fail silently.** The deployment itself
is the only step that tells you when it goes wrong.

| Step | How it fails if you skip it |
| :-- | :-- |
| Ownership transfer | contract owned by the deployer key, `resolveDispute` unavailable to the HSM |
| `NEXT_PUBLIC_ESCROW_CONTRACT` | app reads the *old* contract and reports its state as current |
| `ESCROW_DEPLOY_BLOCK` | every event query scans from genesis, ~36× the requests (`CC-070`) |
| Vercel rebuild | `NEXT_PUBLIC_*` is inlined at build time — changing the var alone does nothing |
| `chain-constants.json` | the next session believes a stale address over the chain |
| Old in-flight tasks | funds reachable only by their own parties; nothing migrates them |

---

## Before you start

### 0.1 — Is this the right operation?

A redeploy is a **one-way door on mainnet** and cheap on Sepolia. Two different bars:

- **Sepolia:** redeploy freely. It is testnet. The only cost is re-running the lifecycle.
- **Mainnet:** `CC-034`, and it is gated on the whole of `CC-076` plus the 2-of-4 Safe (`ADR-0006`
  D2, `CC-090`). Do not deploy mainnet to "get it out of the way" — an unfunded mainnet contract
  with the wrong owner is a liability, not progress.

### 0.2 — Settle the old contract first

The old deployment keeps whatever is in it. This script does not migrate tasks and cannot.

```bash
node --env-file=.env.local scripts/audit/verify-unclaimed.mjs
node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs
```

Run these **against the old address, before you change anything.** `totalLocked() == 0` is the
clean state. If it is not zero, either settle those tasks or accept that the parties to them will
have to interact with the old address directly, from a dashboard that no longer points at it.

### 0.3 — Compile from the source you think you are deploying

```bash
npm run compile
npm run test:contracts
npm run gen:abi -- --check
```

The ABI check matters here specifically: a stale `src/lib/contracts/*-abi.ts` is
**indistinguishable at runtime from a contract that lacks the function.**

### 0.4 — Environment

`.env.local` needs:

| Variable | Notes |
| :-- | :-- |
| `DEPLOYER_PRIVATE_KEY` | funded with ETH on the target network |
| `NEXT_PUBLIC_USDC_ADDRESS` | **per network** — a wrong value here strands every future deposit |
| `VERDICT_SIGNER_ADDRESS` | from `npm run verify:kms`. The deploy refuses without it |

`VERDICT_SIGNER_ADDRESS` is seeded at construction so the contract can verify a verdict from its
first block. Deploy without it and you get a working contract with a silently dead settlement path.

---

## Deploy

```bash
npx hardhat run scripts/deploy/escrow.ts --network baseSepolia
```

(`--network base` for mainnet.)

The script reads every constructor-set value **back off the chain** rather than trusting the
arguments, and **refuses** if `ARBITRATION_WINDOW` is not 604800s. That refusal is deliberate:
`ADR-0006` makes the clock bytecode-or-never, so the only fix after funding is a second deploy with
a migration.

### If verification throws but the deployment looks fine

It probably is fine. The public Base Sepolia gateway load-balances across backends with no
read-your-writes guarantee, so a read issued right after the deploy can hit a node that has not seen
the block yet. This surfaced on 2026-08-15 as `could not decode result data (value="0x")` from
`owner()` against a deployment that had succeeded.

The script retries six times. If it still fails, **confirm, do not redeploy:**

```bash
node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs <address>
```

---

## After the deploy — none of this is optional

### 1 — Transfer ownership

**A fresh deploy is owned by the deployer.** It must not stay that way (`CC-059`, `CC-082`).

```bash
npm run transfer:ownership
node --env-file=.env.local scripts/audit/verify-contract-owner.mjs
```

Expected owner: the HSM key `0xa8931097540e69B474013D294d0bA6A2cC853e4b` today, and the 2-of-4 Safe
once `CC-090` lands. **Verify by running the script, not by reading this file** — this repo has had
the owner recorded wrongly in *both* directions.

Do this **before anything is funded**. An escrow holding money with the wrong owner is a live
incident, not a to-do.

### 2 — The two environment variables

```
NEXT_PUBLIC_ESCROW_CONTRACT=<new address>
ESCROW_DEPLOY_BLOCK=<block from the deploy output>
```

In `.env.local` **and** in Vercel. Notes on each:

- `ESCROW_DEPLOY_BLOCK` is **not** a `NEXT_PUBLIC_` var, so it takes effect at runtime. It moves
  with every redeploy, and a stale-but-valid value fails *slowly* rather than loudly — the queries
  work, they just scan a range that starts too early or misses events entirely.
- A blank value is not an unset one. `VAR=`, a cleared Vercel field and an unset Actions secret all
  arrive as `""`, and `BigInt("")` is `0n` — which scans from genesis (`CC-097`).

Lost the block number?

```bash
node --env-file=.env.local scripts/audit/find-deploy-block.mjs
```

### 3 — Rebuild Vercel

**`NEXT_PUBLIC_*` is inlined at build time.** Changing the variable without a fresh deploy does
nothing at all, and the app keeps reading the old contract while every config screen says otherwise
(`CC-014`).

### 4 — Verify against the chain

```bash
node --env-file=.env.local scripts/audit/verify-escrow-deployment.mjs
node --env-file=.env.local scripts/audit/verify-contract-owner.mjs
node --env-file=.env.local scripts/audit/verify-escrow-solvency.mjs
npm run monitors
```

`verify-escrow-deployment.mjs` now checks `ARBITRATION_WINDOW` and the
`releaseAfterArbitration` selector. Its absence is **informational on testnet** — the app reads a
pre-clock deployment deliberately — and **fatal on mainnet**.

### 5 — `chain-constants.json`

Update the address, the deploy block, and the note on `arbitrationWindowSeconds`, which currently
records that the clock is deployed nowhere.

This file is the record of what is *actually on chain*. The next session will believe it over
`CLAUDE.md`, which is the point of having it — so leaving it stale is worse than having no record.

### 6 — `CLAUDE.md`

Two entries go stale on every redeploy: the escrow address/deploy block, and the arbitration-clock
entry that says the clock is written but deployed nowhere. Correct them in the same commit.

---

## What a Sepolia redeploy unblocks

The dispute stage of the lifecycle cannot be exercised against a contract with no arbitration clock:
there is no timeout to test. So:

- `CC-079` (dispute stage) needs the redeploy before it can start.
- `CC-077`/`CC-078` (funding, settlement) do not — they work against either contract — but running
  them on the old address means re-running them after the redeploy, since the address changes.

**So redeploy Sepolia first, then run all three stages once.** Doing the stages first is doing them
twice.

---

## Related

`CC-034` (mainnet deploy) · `CC-039` (go-live gate) · `CC-059` (HSM ownership) · `CC-070`
(`ESCROW_DEPLOY_BLOCK`) · `CC-082` (v2 deploy, ownership reset) · `CC-090` (Safe, signer separation) ·
`ADR-0006` D2/D3 · `docs/HSM-Deployer-Checklist.md` · `docs/BCP-DR.md`
