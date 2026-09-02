---
id: ADR-0009
title: Session auth and signing hygiene — sign once at connect, then only when the chain is touched
status: proposed
date: 2026-09-02
deciders: Aaron Clifft
depends-on: ADR-0005 (offer acceptance semantics), ADR-0002 (privacy posture), CC-093 (wallet-ownership proof pattern)
resolves: NOR-322 (CC-101 hub), the design question NOR-322 recorded on session lifetime and storage
area: architecture
epic: public-launch
---

# ADR-0009 — Session auth and signing hygiene

## Status

**Proposed, 2026-09-02.** Drafted after Aaron set the product direction during the NOR-322
discussion: wallet prompts are an anxiety-inducing moment for non-crypto users, so the site should
ask for one on connect, and otherwise only when something writes to the chain. Low-stakes actions —
accepting a job, setting rates and skills, notification channels — should ride a persistent
session.

### Product ruling (2026-09-02, Aaron)

The platform is engineered for **agents hiring humans** — the human side of the product is the
worker side. Worker-side automation is deliberately **not engineered as a product** (no delegation
UX; the scoped-token future needs its own ADR and a demand signal) but deliberately **not locked
out** either: D6 keeps the per-request machine path available to any caller, which is the door a
savvy worker points their own agent at, and D4 keeps scopes in the schema so a future A2A expansion
is additive. The platform's answer to a misbehaving worker is reputation and the AWOL/lapse
mechanics (`ADR-0005`), not auth. One consequence stated plainly: today, that door means the
worker's automation holds the worker's own key, since machine callers sign wallet challenges —
sharing it is the worker's choice, on them.

## Context

`src/app/dashboard/page.tsx`'s `signedApiHeaders()` mints a fresh challenge-response signature for
every off-chain API call — task list, notification channels, profile update, offer decisions. Each
is a full `POST /api/basedhuman.mcp/challenge` round trip plus a wallet signature, so navigating
the dashboard prompts signatures indistinguishable, from the worker's seat, from transaction
confirmations — for actions that touch no contract. This is the CC-093/CC-004 wallet-ownership
proof pattern (correct in principle) applied **per request** instead of **per session**.

The pattern's cost is now user-facing, not merely annoying: the 2026-09-01 worker walkthrough
(NOR-321) found the prompt anxiety was the loudest complaint about the product's feel.

Two facts scope the problem:

1. **On-chain writes always prompt natively.** `writeContract` goes through the wallet's own
   confirmation UI regardless of anything built here. That prompt is load-bearing and stays.
2. **Evidence submission is off-chain.** `POST /api/verdict` takes the bundle, the deterministic
   checker runs, and the platform signs the result. No wallet signature is involved until the
   worker's wallet submits the contract write itself. The "job done — check the evidence and pay
   me" moment **is** the wallet's transaction confirmation; there is no third platform-level
   signature to design away.

## Decision

**D1 — Sign once, at connect.** The dashboard authenticates with one challenge-response signature
(SIWE-style: reuse the existing `buildChallengeMessage` / `mcp_challenges` machinery) whose verified
wallet mints a session. The server returns an opaque random token (256-bit, `ccs_`-prefixed);
only its SHA-256 hash is stored (new `sessions` table, migration — next number per the
`ls`-the-directory rule). The per-request signing in `signedApiHeaders()` is deleted; on a 401 or
expiry the client falls back to one fresh challenge, per NOR-322's acceptance.

**D2 — One token, two transports.** The browser holds it in an `httpOnly` `Secure` cookie with
`SameSite=Strict` (strict, not lax: the API surface gains cookie-based auth and loses the
can't-send-custom-headers-cross-origin CSRF resistance the current header scheme had for free).
Non-browser clients — the worker-side agents this ADR reserves for — present the same token as
`Authorization: Bearer`. One issuance path, two transports, no parallel schemes.

**D3 — The boundary in one sentence: a session is not a wallet.** A session authorises off-chain
API calls for the holder's own data: task lists, profile, rates, skills, channels, offers
(accept/decline), evidence submission to the checker. It can never move funds, sign a verdict,
produce a transaction, or satisfy a contract-side check. Every on-chain authorisation remains a
native wallet prompt. The worker signs at connect, and then only when the chain is touched —
which is the wallet's own doing.

**D4 — Tokens carry scopes from day one.** The `sessions` row stores a scope set even though
human sessions ship with exactly one: the full off-chain scope above. This is what makes worker-side
agent delegation (a scoped, named, revocable token minted in-dashboard; a future ADR) additive
rather than a rewrite of the auth primitive. Not built here — reserved here.

**D5 — Lifetime: 30 days, sliding, revocable.** Each authenticated use refreshes `expires_at`;
the dashboard gains a session list (name, last used, revoke) so a worker can end any session.
Server-side revocation is possible because the token is a hashed row, not a stateless JWT.

**D6 — MCP and hiring agents keep per-request challenge-response.** Machine callers pay no
anxiety cost for prompts, the MCP transport's proof requirements are stricter, and x402 settlement
already touches the chain without any session. Nothing in the agent path changes.

## Alternatives rejected

- **Status quo (per-request signatures).** The thing being fixed; anxiety cost measured in NOR-321.
- **Stateless JWTs signed by a platform secret.** Cannot be revoked individually, so "sign out
  everywhere" and "fire my agent" become impossible or require a denylist — at which point the
  state is in a database anyway, so the signature bought nothing. Also adds a second long-lived
  secret to guard.
- **Wallet-derived key material in `localStorage` (client-side session keys).** Exfiltratable by
  any XSS, and it blurs D3's boundary by making the client look walletish. The server-issued opaque
  token keeps key material out of the browser entirely.
- **Short sessions (hours) instead of 30 days.** Re-prompts would reintroduce the exact cost this
  ADR removes, for a threat whose worst case is bounded and reversible: rates are public data,
  offers are the worker's own consent, and no path to funds exists without a wallet prompt.
  Proportionality favours 30 days with revocation.

## Consequences

- `signedApiHeaders()` and its per-call challenge round trips disappear from the dashboard;
  NOR-322's acceptance ("zero signatures after the initial session, wallet prompt only at connect
  or on-chain write") becomes testable.
- The `mcp_challenges` table gains a second consumer (session minting) — its single-use semantics
  are already enforced, so no new invariant.
- A new `sessions` table is the third place auth state lives (challenges, channels, sessions); the
  RLS posture follows CC-062's rule — revoke the default grants in the same migration.
- Loss of a session token is loss of nothing but a re-sign: there is no recoverable value in a
  stolen session beyond off-chain actions, and it is revocable by the worker.
- Worker-side agent delegation (scopes in anger) needs its own ADR before any token leaves a
  dashboard; this ADR only guarantees it will not require a migration of the auth primitive.
