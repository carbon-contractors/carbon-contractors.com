# CC-072 — Staking lifecycle harness (Base Sepolia)

Drives the on-chain half of the never-executed reputation staking flow
(`CC-072`): **approve → stake → cooldown refusal → (7 days) unstake**, verifying
after every state change that both the chain AND the dashboard's own data path
(`/api/reputation`) reflect the result — "the dashboard correctly reflecting the
result at each step" is the ticket's acceptance, and the chain alone does not
satisfy it.

```
USDC.approve(stake, 20)  →  ReputationStake.stake(20)   [worker wallet, two txs]
unstake(1) during cooldown — must revert CooldownNotElapsed(readyAt)
(after 7 days) unstake(20) → USDC returned to the worker
```

The harness signs with a **worker** wallet — `WORKER_WALLET_PRIVATE_KEY`, never a
platform key. `stake()` records `msg.sender` as the staker, so the staker IS the
worker; staking from `DEPLOYER_PRIVATE_KEY` or the HSM owner would conflate the
worker and platform roles in the very record this ticket exists to produce (the
same anti-conflation rule as `CC-077`'s `AGENT_WALLET_PRIVATE_KEY`, `CC-081`
Defect 1). The harness hard-refuses the three known platform addresses.

## Prerequisites

- A **dedicated throwaway worker wallet** on Base Sepolia (testnet only) holding:
  - **≥ 20 test USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — from
    Circle's faucet (faucet.circle.com → select **Base Sepolia**; GitHub or
    Circle account, ~20 USDC per address per 2h window), or a transfer from
    any funded testnet wallet. It must NOT be any key in
    `scripts/staking/config.mjs`'s `FORBIDDEN_STAKERS`.
  - a little ETH for gas (Coinbase Developer Platform faucet — a stake is two
    transactions, effectively dust at Base Sepolia prices).
- A `.env.local` (never committed — `.env.example` documents var names) with the
  vars below. A dedicated `BASE_SEPOLIA_RPC_URL` (CC-048): the public gateway's
  rate limit and read-your-writes lag are what make live runs flaky
  (`Lessons-Learned` §16).
- The chain parameters (stake contract, USDC, chain id) come from
  `chain-constants.json` (`networks.base-sepolia`) — the harness never reads
  them from env and never re-derives them.

## Environment variables

| Var | Required | Notes |
| :-- | :-- | :-- |
| `BASE_SEPOLIA_RPC_URL` | yes | A **dedicated** endpoint (CC-048). Setting it to the public gateway is the same as leaving it unset. |
| `WORKER_WALLET_PRIVATE_KEY` | yes | **New var, defined by this harness.** The worker wallet's key (`0x` + 64 hex), testnet only. Must NOT be `DEPLOYER_PRIVATE_KEY` or any platform key (checked against derived addresses). Never printed or logged; read only at `--execute`. |
| `NEXT_PUBLIC_BASE_URL` | yes | Where to reach `/api/reputation` — the production URL works; `/api/*` bypasses the coming-soon gate, so the harness proves the production data path even while the UI is gated. |
| `NEXT_PUBLIC_BASE_NETWORK` | no | If set, must be `testnet` — the harness is pinned to base-sepolia. |

Config problems are reported **all at once**, never one var at a time. Blank
(`VAR=`) counts as unset (CC-097).

## Phases

The 7-day cooldown makes this **resumable by necessity** (same shape as the
CC-082 escrow lifecycle proof): state lives in `.stake-lifecycle-state.json`
(git-ignored), every phase re-derives its preconditions from the chain rather
than trusting the file, and each phase can run days apart. Default mode is
`--dry-run`; nothing touches the network beyond config validation.

```bash
# 0. where things stand — read-only
node --env-file=.env.local scripts/staking/stake-lifecycle.mjs --phase=status --execute

# 1. the first-ever real stake (approve + stake, then chain & API verification)
node --env-file=.env.local scripts/staking/stake-lifecycle.mjs --phase=stake --amount=20 --execute

# 2. immediately after: the cooldown guard (eth_call only — no broadcast)
node --env-file=.env.local scripts/staking/stake-lifecycle.mjs --phase=cooldown-refusal --execute

# 3. ≥ 7 days after staking (calendar reminder recommended)
node --env-file=.env.local scripts/staking/stake-lifecycle.mjs --phase=unstake --amount=20 --execute
```

What each phase proves, and refuses to fake:

- **status** — wallet balances, stake info, cooldown ETA; recorded to the state
  file. Also the precondition probe the other phases share.
- **stake** — refuses below-minimum amounts, underfunded wallets, top-ups on an
  existing stake (they reset the cooldown clock), and any `FORBIDDEN_STAKERS`
  key. On success: reads back `getStake`, decodes the `Staked` event, and polls
  `/api/reputation` until it reflects the stake — asserting the exact
  `compute.ts` math (a 20 USDC first stake on a task-less wallet ⇒ stake
  component 8, total floor 13). A mismatch is reported honestly as the
  `CC-010` surface, not as failure of the chain leg.
- **cooldown-refusal** — `eth_call`s `unstake(1)` mid-cooldown and requires the
  revert to be `CooldownNotElapsed(readyAt)`. Anything else — including a
  successful simulation — is a defect report, not a test failure. Also records
  whether the revert carries `readyAt`, which is what `reverts.ts` maps to
  "Stake changes have a cooldown — try again once it has elapsed." in the UI.
- **unstake** — refuses to run before the cooldown elapses, refuses
  partial-unstake amounts that would strand a below-minimum remainder
  (`InvalidUnstakeAmount`: the contract is all-or-at-least-min). On success:
  verifies the wallet's USDC balance increased by the exact amount, stake
  reduced, and `/api/reputation` reflects it.

## The UI leg — a human step, by design

CC-072's acceptance says **"through the actual UI, on a real wallet"**. The
harness proves the on-chain mechanics and the production data path, but the UI
walkthrough is deliberately not scripted:

1. **EOA leg**: connect the throwaway worker wallet in a browser (a fresh
   profile with no extensions — `Lessons-Learned` §1) to the dev server
   (`npm run dev`) or the deployment, open the dashboard, click **Stake**,
   confirm both transactions in the wallet, and watch the stake balance update
   (`fetchData()` re-fetch on `txConfirmed`).
   The coming-soon gate (`NEXT_PUBLIC_COMING_SOON !== "false"` in
   `middleware.ts`) covers the deployment, not a local dev server — set
   `NEXT_PUBLIC_COMING_SOON=false` in `.env.local` for the dev run only; do NOT
   flip it in Vercel (that flip is `CC-014`, sequenced behind `CC-039`).
2. **Smart Wallet leg** (`CC-072` explicitly asks for both architectures):
   create a Base Account via passkey (the `CC-069` path) funded with ≥ 20 USDC,
   and repeat stake/unstake through the passkey prompts. The `approve`→`stake`
   pair from a 4337 account exercises ERC-1271/6492 signing in `useWriteContract`
   — architecturally different from the EOA leg, which is the point.
3. Before unstake is available in the UI: attempt it anyway and confirm the
   failure surfaces as the `CooldownNotElapsed` sentence from `reverts.ts`, not
   a raw revert blob.

Evidence from the UI runs (tx hashes, screenshots) belongs in the ticket with
the harness output, same as the CC-082 lifecycle proof.

## Why a harness and not just clicking

Because "never executed" is only half the defect. The other half is that nothing
exists to re-run. A worker's first stake failing silently on some wallet type,
after launch, would be found by a user. This harness makes the on-chain half a
repeatable protocol anyone can run against any deployment — and the 7-day tail
means the first run should start the day the wallet is funded, not the day
someone remembers.
