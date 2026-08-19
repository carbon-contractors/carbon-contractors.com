# Mainnet infrastructure migration checklist

Companion to CC-039 (the go-live gate hub) — this is the technical execution layer for the testnet → mainnet infra swap specifically, written after finding that RPC provider/redundancy has no owner anywhere in the current backlog (see below). CC-039 stays the business/content/security-sweep authority; this is the "did every testnet-only thing get a deliberate mainnet decision, not just a renamed variable" pass.

## 1. RPC layer — the gap this checklist exists because of

- [ ] **New ticket filed** covering RPC provider selection for mainnet (currently uncovered by CC-034, CC-039, or CC-040 — confirmed by reading all three in full, 2026-08-19).
- [ ] Primary paid RPC provider selected and provisioned for Base mainnet (QuickNode ~99.99% advertised SLA, or equivalent — pick on cost/latency, not just the headline number).
- [ ] Secondary, *independent* provider provisioned for failover (different company, different infra — e.g. Ankr or dRPC alongside an Alchemy/QuickNode primary). Same-provider redundancy doesn't count.
- [ ] Failover wired at the code level, not just documented as a manual runbook step — viem's `fallback()` transport, ordered primary → secondary → (optionally) public endpoint as last resort.
- [ ] Decide explicitly whether the invariant-monitor scripts (`verify-escrow-solvency`, `verify-signer`, etc.) share the app's RPC config or get their own — if shared, one outage takes down both live traffic and your ability to see that it's down.
- [ ] Confirm whether Coinbase's own CDP "Base Node" free tier is used anywhere in the chain (it's free/rate-limited, same category as the public endpoint that just failed on Sepolia five times in one alert — fine as a third-tier fallback, not fine as primary or secondary).
- [ ] Rate limits on the chosen tier(s) checked against actual expected call volume (live traffic + monitor scripts running on schedule) — a limit that's fine today may not be once monitors run hourly against real usage.

## 2. Contract & address swap

- [ ] Fresh `CarbonEscrow` deployed to Base mainnet from a **deployer wallet never used on testnet** (CC-034's own stated requirement).
- [ ] Fresh `ReputationStake` deployed, if in scope for launch.
- [ ] `completeTaskByOwner(taskId)` emergency function added at this deploy — CC-034 already flags this as the one cheap window to add it (ties to CC-049).
- [ ] Slither scan run against the mainnet contract (CC-034 update, 2026-07-25).
- [ ] Basescan source verification completed (same update).
- [ ] KMS-derived signer address authorised on the new contract; confirm via the mainnet equivalent of `verify-contract-owner.mjs` that the derived address actually matches `owner()` on Basescan — don't assume the testnet fix (CC-059) automatically carries over to a fresh deployment.
- [ ] `DEPLOYER_PRIVATE_KEY` confirmed absent from every mainnet-facing environment (CC-034).

## 3. Environment variables — repoint, don't assume

- [ ] `NEXT_PUBLIC_BASE_NETWORK` → `mainnet`
- [ ] `NEXT_PUBLIC_USDC_ADDRESS` → `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (per your own March audit table — verify this is still current before pasting it in blind)
- [ ] `NEXT_PUBLIC_ESCROW_CONTRACT` → fresh mainnet deploy address
- [ ] `NEXT_PUBLIC_REPUTATION_STAKE_CONTRACT` → fresh mainnet deploy address, if applicable
- [ ] `NEXT_PUBLIC_BASE_URL` → production domain
- [ ] `BASE_MAINNET_RPC_URL` (or equivalent) → the primary provider from §1, not a placeholder
- [ ] Confirm no env var silently falls back to a testnet default if unset (this exact failure mode is CC-097 — set-but-empty vars bypassing defaults — worth re-checking specifically for the mainnet cutover, not just trusting it stays fixed).

## 4. Monitoring re-pointing

- [ ] Every invariant monitor script (`verify-escrow-solvency`, `verify-contract-owner`, `verify-signer`, `verify-unclaimed`, `verify-concurrent-escrow`, plus whichever of `verify-checker`/`verify-commitments`/`verify-retention`/`verify-verdict-rate` exist by launch) re-pointed at mainnet contract addresses and the new RPC config from §1.
- [ ] Discord/Healthchecks.io alert copy confirmed to say `network mainnet`, not `network testnet` — small, but it's the one line that tells you at 2am whether real money is involved.
- [ ] Scheduled GitHub Actions workflow (`monitors.yml`) confirmed running against mainnet config, not still pointed at Sepolia out of habit.
- [ ] `/api/health` endpoint confirmed reporting mainnet contract/RPC status, not testnet.

## 5. Decisions that should land *before* mainnet, not after (carried over from earlier this thread)

- [ ] Sanctions oracle check (Chainalysis `isSanctioned()`, already deployed on Base) wired into `createTask`/`completeTask` or the MCP `request_human_work` handler — no ticket exists yet; this is the one compliance item that doesn't wait on AUSTRAC's classification guidance.
- [ ] A decision made on the `resolveDispute` `onlyOwner` override — timelock it, renounce it, or route it through the jury tier — before real money can flow through it unilaterally.
- [ ] CC-051 (AUSTRAC/Digital Assets Framework classification) at least consulted, even if not fully resolved — no de minimis exemption applies regardless of launch-day user count.

## 6. Sequencing note

Per CC-039's own stated order: `CC-076` (Sepolia validation gate) clear → this checklist + CC-034 execution → mainnet smoke test with Aaron's own funds → §5 items confirmed → `CC-014` flips the coming-soon gate → 48-hour watch. Nothing here should run *before* the Sepolia gate closes, and the security sweep (CC-039) should run immediately before cutover, not in advance — it goes stale the moment anything else changes.
