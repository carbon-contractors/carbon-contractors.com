# Carbon Contractors — Full Linear Export

Exported: 2026-07-25 · Project: Carbon-Contractors · Team: North Metro Tech
Total issues: 37 (24 Done, 2 Canceled, 2 Todo, 9 Backlog)

## Project metadata
- Status: In Progress · Priority: High · Started: 2026-04-20 · Target: 2026-05-31
- Lead: aaron@northmetrotech.com.au

## Project documents (titles/URLs only — body content isn't readable via this tool set; open directly in Linear or ask me to try another route)
- **Architecture Overview — Carbon Contractors Platform** — https://linear.app/north-metro-tech/document/architecture-overview-carbon-contractors-platform-097847d43322
- **MVP Definition of Done — Testnet → Mainnet Gate** — https://linear.app/north-metro-tech/document/mvp-definition-of-done-testnet-mainnet-gate-19ec3ae7e8af
- **Security & Trust Disclosure: Zero-Secret Escrow Architecture** — https://linear.app/north-metro-tech/document/security-and-trust-disclosure-zero-secret-escrow-architecture-4fb44305efd8
- **Checklist: Zero-Secret HSM Deployer for Base (EVM)** — https://linear.app/north-metro-tech/document/checklist-zero-secret-hsm-deployer-for-base-evm-80eda215ad4f

---

## ACTIVE — Backlog / Todo (11)

### NOR-306 — OPS: Mainnet go-live gate checklist [Urgent] [Backlog]
Consolidated mainnet go-live gate. Related: NOR-184, NOR-305, NOR-195, NOR-196, NOR-304, NOR-303, NOR-288, NOR-301, NOR-292.

Gates: Security (NOR-288 OnchainKit migration, NOR-301 GCP key enforcement, NOR-303 Next.js patch, NOR-195 key recovery doc, NOR-196 KMS/Sepolia e2e test — all listed as unchecked here despite NOR-196/185 showing Done elsewhere, worth reconciling) · Infrastructure (NOR-305 monitoring, Cloudflare WAF review, Vercel env var check) · Contract (deploy to Base mainnet, Slither scan, Basescan verify) · Content/Business (NOR-292, NOR-304, Security-Trust-Disclosure.md current, /learn testnet language review) · Smoke test (full fund→complete→pay lifecycle on mainnet, dispute flow) · Post-go-live 48hr checks.

### NOR-305 — OPS: Production monitoring + alerting [High] [Backlog]
Error alerting (Vercel log drain, Sentry), on-chain monitoring (CarbonEscrow events, KMS signing failures, deployer ETH balance — moot if NOR-183 lands), uptime (external monitor + /api/health), runbook per alert type. Related: NOR-183, NOR-191, NOR-306.

### NOR-301 — SEC: Enforce GCP security key requirement [High] [Backlog]
YubiKey-only 2FA enforcement at GCP org/project level, no TOTP/SMS fallback, verify gcloud CLI requires FIDO2, verify KMS service account has no interactive login path, document final 2FA posture in Security-Trust-Disclosure.md. Related: NOR-185 (Done), NOR-196 (Done), NOR-306.

### NOR-303 — DEP: Next.js high-severity DoS patch (Dependabot #26) [High] [Backlog]
GHSA-q4gf-8mx6-v5v3. Claude Code prompt already written. Branch-based fix, verify build + no breaking changes, merge, close PR. Related: NOR-306.

### NOR-288 — Migrate off OnchainKit → standalone wagmi + viem [Medium] [Backlog]
2 files affected (`providers.tsx`, `NavBar.tsx`). wagmi 2.19.5 + @tanstack/react-query 5 already installed. Base migration guide + skill available. Not blocking mainnet but should land before/immediately after launch. Related: NOR-306, NOR-289 (Endless Runner counterpart).

### NOR-300 — Build basedhuman-mcp MCP server [High] [Backlog]
Tools: listTasks, getTask, submitBid, completeTask (reads contractor wallet from on-chain escrow, not Supabase), getAgentStatus. Decisions needed: STDIO vs HTTP/SSE transport, challenge-response auth (NOR-178 pattern), Zod validation, x402 integration. Must satisfy NOR-293 hardening before any npm publish beyond name reservation. Related: NOR-293, NOR-178 (Done).

### NOR-293 — MCP supply chain + STDIO hardening for basedhuman-mcp [High] [Backlog]
Response to Register/Ox Research MCP STDIO design flaw (~200k servers, 10+ CVEs). Four vuln classes to check: command injection, argument injection hardening bypass, zero-click prompt injection via MCP config, marketplace poisoning. Extensive checklist: code audit (grep child_process/exec/spawn/eval, Zod validation everywhere), supply chain (npm 2FA via YubiKey, GitHub Actions OIDC provenance publish, `npm audit signatures`, Dependabot, `.npmignore` scope), consumer guidance (README provenance steps, SECURITY.md update), defense-in-depth note that `completeTask()` pulling wallet from on-chain state protects funds even if MCP config is compromised. Related: NOR-196, NOR-185, NOR-300, NOR-294.

### NOR-294 — MCP production readiness: idempotency, pre-set params, retry semantics [Medium] [Backlog]
Inspired by MCP co-creator David Soria Parra's ShiftMag interview (protocol doesn't define retries/failure handling — ecosystem must). Scope: pre-set params (chain ID, escrow address, USDC address, RPC URL all config-time constants, not agent-supplied — kills lookalike-token vector), idempotency (createTask/fundEscrow/completeTask all idempotent via idempotency keys, TTL + storage in Supabase or Upstash Redis), retry/failure semantics (structured `{retryable, reason, code}` errors, exponential backoff, pending-tx polling), observability (structured logs, correlation IDs, no PII/secrets in logs), tool surface governance (single source of truth, versioned schema), progressive discovery (lower priority — fine while tool count <10). Related: NOR-179 (Done), NOR-293.

### NOR-302 — OPS: Migrate git commit signing SSH → GPG on YubiKey [Medium] [Backlog]
Generate GPG key on YubiKey (prefer generate-on-device), configure git global signing, auto-sign, add pubkey to GitHub, verify Verified badge, update WSL config separately from Windows native, document key ID in Bitwarden, confirm Ledger Nano X still backup-enrolled. Related: NOR-185 (Done).

### NOR-292 — Remove Stables affiliate references — Stables sunsetting [Low] [Backlog]
Stables (stables.money) sunsetting, likely AU regulatory cause. Not an architectural dependency. Checklist: audit all 6 /learn modules, remove `NEXT_PUBLIC_STABLES_AFFILIATE_URL` from Vercel env + Zod config schema, grep codebase for "stables", check README/docs. Includes a quick grep command to verify if already clean. Related: NOR-306, NOR-304.

### NOR-304 — CONTENT: Replace Stables with AU USDC offramp alternative in /learn [Medium] [Backlog]
Research AU offramp options — note: **Coinbase Australia received direct ASIC AFSL approval April 7, 2026**, making it the strongest current AU recommendation under the Corporations Amendment (Digital Assets Framework) Bill 2025. Update /learn module(s), flag or drop affiliate angle, verify no Stables references remain post-NOR-292. Related: NOR-292, NOR-306.

### NOR-195 — OPS: AUD-010 — Document key compromise recovery procedure [Low] [Todo]
Contract uses OpenZeppelin Ownable; `transferOwnership()` rotates `resolveDispute()` authority but `completeTask()` checks `msg.sender == task.agent` from original key — old in-flight tasks stuck if key rotates. Recovery path: dispute → `resolveDispute(taskId, true)` with new owner (manual). Remediation: document as runbook; optionally add `completeTaskByOwner(taskId)` emergency function in next contract version. Related: NOR-185 (Done), NOR-306, NOR-196 (Done).

### NOR-183 — ARCH: Requester gas stake — self-funding escrow release pool [High] [Todo]
Converts NOR-181's gas monitoring problem into a product feature. Requester stakes task value + small gas buffer (~$0.50–$1 USDC) on task creation; buffer swaps to ETH → platform gas pool. Forfeit failsafe: if pool empty, task value releases directly from escrow, no platform wallet involvement. Shared pool recommended for MVP over task-scoped. Benefits: requester skin-in-the-game, self-healing ops, trust signal, micro-revenue model (buffer slightly above actual gas cost). MVP simplification: accept ETH buffer separately from USDC, skip on-chain swap. Resolves/supersedes NOR-181 (Canceled). Related: NOR-181, NOR-305, NOR-185 (Done).

### NOR-280 — INFRA: Self-hosted Sepolia archive node on Z220 [Low] [Backlog]
Repurpose Z220 (headless Ubuntu) as self-hosted Sepolia node — removes RPC rate limits, adds independent KMS-audit cross-reference capability (post NOR-196), monitoring hooks. Hardware check needed: storage is the constraint (archive ~1.5–2TB NVMe vs pruned ~200–400GB). Stack: Geth + Lighthouse recommended (best docs for first-timers) vs Nethermind/Erigon + Prysm/Teku alternatives. 4 phases: baseline pruned node → Grafana/Prometheus monitoring → KMS audit feed cross-reference (post-NOR-196) → optional archive upgrade. Security: local-network-only RPC, no signing keys on node, YubiKey-gated SSH. Explicitly "future hyperfocus session" item, not mainnet-blocking. Related: NOR-196 (Done).

---

## DONE (22)

### NOR-196 — SEC: Migrate platform signer to GCP Cloud KMS [High] [Done: 2026-04-24]
The big one. Full zero-static-secret signer architecture: key generated inside GCP HSM, never exists as extractable string; Vercel OIDC → GCP STS → KMS signing (Workload Identity Federation, no JSON service account keys anywhere); separate WIF provider for GitHub Actions contract deployment, scoped by repo. Ethereum address derived from KMS public key via keccak256. `src/lib/contracts/kms-signer.ts` implements viem-compatible custom account backed by KMS `asymmetricSign`. Fallback to raw key for local dev only. Cost: ~$1-3/mo + $0.03/10k ops. All 12 acceptance criteria checked off including HSM attestation bundle downloaded. Related: NOR-185, NOR-195, NOR-188, NOR-306, NOR-301, NOR-293, NOR-280.

### NOR-184 — Switch DNS to Cloudflare — DDoS/WAF [High] [Done: 2026-03-22]
Full checklist complete: Cloudflare free tier, proxy mode (orange cloud), Bot Fight Mode, Full (Strict) SSL, Automatic HTTPS Rewrites. Note: don't enable Rocket Loader on Next.js. "I'm Under Attack" mode known but left off by default. Upgrade path to Pro ($20/mo) documented for later (full WAF ruleset, advanced rate limiting). Related: NOR-306, NOR-185.

### NOR-191 — SEC: AUD-006 — DB/chain state inconsistency on partial completion [High] [Done]
Fixed via idempotent check: before attempting on-chain call, check if task already completed on-chain; skip and just update DB if so. No fund-loss risk (contract authoritative) but was causing stuck-task confusion. Related: NOR-305.

### NOR-185 — SEC: Wrench attack vector — physical coercion resistance [High] [Done: 2026-04-14]
Threat-modeled 3 attack chains (Vercel/env key read, Supabase wallet-field tamper, GitHub malicious push). MVP mitigations: key separation (cold-stored deployer key vs operational Vercel signer), Vercel Sensitive flag, YubiKey hardware auth across Vercel/GitHub/Supabase, cold storage key off-premises. Post-MVP (deferred until escrow balance grows): timelock on admin functions, multisig ownership, max single-payout limit, escrow balance alerting, documented duress protocol. Explicit economic note: not rational to attack at sub-$1k escrow volumes. Related: NOR-184, NOR-181, NOR-183, NOR-302, NOR-301, NOR-293, NOR-196, NOR-195.

### NOR-178 — SECURITY: Agent authentication — challenge-response signature verification [Urgent] [Done: 2026-03-22]
Fixed the header-trust-as-authentication gap. SIWE-style flow: `/api/mcp/challenge` issues one-time nonce (60s TTL) tied to wallet → agent signs via AgentKit `signMessage` → server verifies via viem `recoverAddress`. Migration for `mcp_challenges` table. Blocks NOR-179. Related: NOR-177, NOR-174, NOR-176, NOR-300.

### NOR-179 — OPS: Rate limiting missing on MCP endpoints [High] [Done: 2026-03-22]
Upstash Redis sliding-window limiter (30 req/min per IP) recommended over next-rate-limit. Scoped to `/api/basedhuman.mcp` and `/api/mcp/challenge` (10 req/min per wallet). Was blocked by NOR-178, implemented alongside it. Related: NOR-294.

### NOR-194 — SEC: AUD-009 — Restrict task_description from public anon access [High, upgraded from Low] [Done: 2026-03-26]
Product decision: keep wallet addresses/amounts/tx hashes public (already on-chain, transparency builds trust) but restrict `task_description` (off-chain free text, could contain PII/location/proprietary info) from anon reads. Solution: `tasks_public` view excluding the column, granted to anon; authenticated RLS for parties to the task; service_role unrestricted. Related: NOR-186.

### NOR-186 — SEC: AUD-001 — RLS leaks PII via anon key (notification_channels + waitlist) [Urgent, Pre-Mainnet Blocker] [Done: 2026-03-25]
`notification_channels` and `waitlist` had permissive anon SELECT policies never revoked. Full dump of contractor contact info + waitlist emails was possible via public anon key. Fixed: dropped both policies, switched `getChannelsForContractor()` to service_role client. Related: NOR-194.

### NOR-193 — SEC: AUD-008 — human_whitepages missing field allowlist [Medium] [Done]
Defense-in-depth: added explicit `.map()` allowlist (wallet, categories, rate_usdc, availability, reputation_score) to prevent future column additions leaking through.

### NOR-190 — SEC: AUD-005 — Task state machine TOCTOU race [High] [Done]
Read-then-validate-then-write pattern had a race window; two concurrent calls could both pass validation and double-transition. Fixed with atomic `UPDATE ... WHERE status = ANY($allowed_sources)` + rowCount check. Note: on-chain contract independently prevents double-payment — this was an operational correctness fix, not a funds-safety one.

### NOR-192 — SEC: AUD-007 — get_contractor exposes notification channel types [Medium-Low] [Done]
Removed `notification_channels[].type` array from MCP response (was leaking which comms platforms a contractor uses + internal UUID). Kept `accepts_auto_booking` boolean only.

### NOR-189 — SEC: AUD-004 — register_notification_channel echoes PII to agent [Medium] [Done]
Tool response included full `address` field (email/Telegram/Discord/webhook) in agent's context window. Stripped to `id`, `type`, `accepts_auto_booking` only.

### NOR-188 — SEC: AUD-003 — No nonce management for concurrent signer ops [Urgent, Pre-Mainnet Blocker (mainnet)] [Done]
Shared singleton signer with no nonce manager caused intermittent "nonce too low" failures under concurrent completions. Fixed with viem's built-in `nonceManager` on the account. Related: NOR-196.

### NOR-187 — SEC: AUD-002 — No DB-level immutability on funded task records [High, Pre-Mainnet Blocker] [Done]
Added Postgres `BEFORE UPDATE` trigger (`prevent_task_mutation()`) blocking changes to `to_human_wallet`, `from_agent_wallet`, `amount_usdc`, `deadline_unix`, `payment_request_id` once a task leaves `pending` status. Belt-and-suspenders on top of on-chain immutability.

### NOR-182 — OPS: Single point of failure on x402 facilitator [High] [Done]
### NOR-176 — SECURITY: Signature replay attack on worker registration [High] [Done: 2026-03-21]
Nonce (min 8 chars) + timestamp (5 min window) required in signed registration message; `used_nonces` table rejects replay; migration `006_used_nonces.sql`.

### NOR-174 — SECURITY: MCP tools lack authentication — resolve_dispute unauthenticated [Urgent] [Done: 2026-03-21]
`McpSessionContext` with `callerWallet` added to MCP server factory; `resolve_dispute`/`confirm_task_completion`/`dispute_task` verify caller wallet matches `from_agent_wallet`. 40/40 tests passing.

### NOR-177 — SECURITY: Medium/low hardening pass [Medium] [Done: 2026-03-21]
5 sub-fixes: CSP splits dev/prod, `updateTaskStatus` enforces state machine, `maskWallet()` auto-masks addresses in logs, `isValidWalletAddress()` extracted to shared validation lib, `npm audit --audit-level=high` in CI.

### NOR-175 — SECURITY: Permissive RLS — anon can INSERT into humans + notification_channels [High] [Done: 2026-03-21]
Migration 003 dropped permissive anon write policies; new migration `005_auth_scoped_rls.sql` adds `auth.uid()`-scoped authenticated policies.

### NOR-173 — RESOLVED: .env.local not committed [Urgent] [Done: 2026-03-21]
False positive from the owasp-sweep skill — file was never committed, confirmed via `git log --all`. Noted as a skill-improvement item: sweep should check git history before raising CRITICAL on env files.

---

## CANCELED (2)

### NOR-181 — OPS: No gas balance monitoring — depleted deployer wallet [High] [Canceled]
Superseded by NOR-183 (requester gas stake architecture eliminates the platform wallet gas dependency entirely). Reopen only if NOR-183 doesn't land.

### NOR-180 — OPS: Supabase connection exhaustion risk under agent load [Medium] [Canceled]
No pooling configured; Vercel serverless spawns new connection per invocation. Canceled — reason not stated in issue body, worth checking whether Supabase pooler (pgbouncer) was addressed elsewhere or genuinely deferred.

---

## Cross-cutting notes for Hermes migration

- **NOR-306 (go-live gate)** is the hub — almost every other open issue is referenced by it. If Hermes' Kanban doesn't support issue-to-issue linking, at minimum preserve this checklist as a single card with the full text above; it's your mainnet readiness source of truth.
- **Relation graph highlights:** NOR-185 (wrench attack, Done) touches 8 other issues — it's the connective tissue for the whole security posture. NOR-293/294/300 (MCP hardening + readiness + build) are a tight cluster that should probably migrate as one epic, not three disconnected cards.
- **Possible stale state:** NOR-306's own checklist text still shows NOR-196/NOR-301/NOR-195 as unchecked boxes even though NOR-196 (and NOR-185, which gates NOR-301) show as Done elsewhere. Worth a quick manual reconciliation pass before you treat NOR-306 as the authoritative go-live status.
- **Comments/discussion threads were not pulled** in this export — if you've left yourself notes in comments on any of these issues, they won't be in Hermes unless you check manually before shelving.
