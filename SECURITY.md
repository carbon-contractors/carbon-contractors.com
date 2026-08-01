# Security

Carbon Contractors handles real payments on Base L2 via USDC. Security is treated as a
first-class concern, not an afterthought.

This document describes the security review process, current findings status, and how to
report vulnerabilities.

---

## Security Review Process

Prior to any public launch, the codebase was swept against two frameworks:

**OWASP Web Application Top Ten (2021)**
Covers application-layer risks: access control, injection, cryptographic failures,
misconfiguration, authentication, and supply chain integrity.

**OWASP Web3 Attack Vectors Top 15 (2026)**
Covers off-chain and operational risks specific to Web3 projects: private key handling,
supply chain attacks on npm dependencies, UI/UX spoofing, DNS/domain security, and
social engineering vectors.

Both sweeps were run against the full codebase on 2026-03-21, before the platform was
opened to users.

---

## Findings & Remediation Status

### Pre-Launch Sweep — 2026-03-21

| Ref | Category | Severity | Status |
|-----|----------|----------|--------|
| NOR-174 | MCP tools lack per-caller authentication | High | ✅ Closed |
| NOR-175 | Permissive Supabase RLS — anon write policies not fully revoked | High | ✅ Closed |
| NOR-176 | Wallet signature replay on registration — no nonce/timestamp | High | ✅ Closed |
| NOR-177 | CSP allows unsafe-inline/eval in production | Medium | ✅ Closed |
| NOR-177 | No idempotency guard on task state transitions | Medium | ✅ Closed |
| NOR-177 | Full wallet addresses written to logs | Medium | ✅ Closed |
| NOR-177 | npm audit not in CI pipeline | Low | ✅ Closed |
| NOR-177 | Inconsistent wallet address validation across endpoints | Low | ✅ Closed |
| —       | .env.local in working directory flagged — confirmed not committed | Info | ✅ False positive |

### Follow-Up Sweep — 2026-03-22

| Ref | Category | Severity | Status |
|-----|----------|----------|--------|
| NOR-178 | Agent authentication — challenge-response signature verification | High | ✅ Closed |
| NOR-179 | MCP endpoint rate limiting — per-endpoint limits + Upstash upgrade path | High | ✅ Closed |
| NOR-182 | x402 facilitator circuit breaker — timeout + fail-fast pattern | High | ✅ Closed |
| NOR-180 | Supabase connection pooling | Medium | ✅ Not applicable |
| NOR-181 | Gas monitoring cron | — | ✅ Superseded by NOR-183 |

**NOR-180 note:** The platform uses `@supabase/supabase-js` which communicates via the
PostgREST HTTP API, not direct Postgres connections. Connection pooling (pgbouncer) only
applies to direct wire-protocol connections. If the project migrates to direct Postgres
access (e.g. Prisma, Drizzle, or `pg`), connection pooling via Supabase Transaction
Pooler (port 6543) must be configured before deployment.

**NOR-181 note:** Superseded by NOR-183 (requester gas stake), which eliminates the
platform wallet gas dependency entirely.

All findings from both sweeps are resolved or closed. Remaining open work (NOR-183
requester gas stake) is tracked in the Linear backlog as a separate architectural feature.

### Pre-Mainnet Audit — 2026-03-25

Full report: [AUDIT-2026-03-25.md](AUDIT-2026-03-25.md). Operational follow-ups:

| Ref | Category | Severity | Status |
|-----|----------|----------|--------|
| AUD-010 | Owner rotation does not cover in-flight `completeTask` calls — recovery procedure documented | Low | ✅ Runbook: [docs/Key-Compromise-Recovery.md](docs/Key-Compromise-Recovery.md) |

---

## Platform Security Architecture

A few design decisions relevant to the threat model:

**No seed phrases.** Contractors authenticate via Coinbase Smart Wallet using passkeys.
There is no seed phrase to steal or phish.

**USDC only.** The platform transacts exclusively in USDC on Base L2. No native token,
no approval-for-all flows, no liquidity pools.

**Escrow model.** Funds are held in escrow for the duration of a task. Neither the agent
nor the platform holds contractor funds speculatively.

**x402 payment protocol.** Payments are verified on-chain before task activation. The
platform does not trust facilitator responses without secondary verification (NOR-177
remediation in progress).

---

## Reporting a Vulnerability

If you find a security issue, please report it privately before disclosing publicly.

**Email:** security@carbon-contractors.com
**Response target:** 48 hours

Please include:
- Description of the issue
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We don't have a bug bounty programme yet, but will acknowledge all valid reports in this
document and aim to remediate within 30 days of confirmation.

---

## Responsible Disclosure Policy

- Please give us 30 days to remediate before public disclosure
- Don't access, modify, or exfiltrate data beyond what's needed to demonstrate the issue
- Don't perform DoS, spam, or social engineering against users or staff

We'll do the same in return — act in good faith and we will too.

---

*Last updated: 2026-03-22*
