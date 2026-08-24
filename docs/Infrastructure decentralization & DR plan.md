# Infrastructure decentralization & DR plan

> **Operational Runbook Note (2026-08-23):** The operational procedures, failover instructions, and succession decisions outlined below and in `ADR-0006` are consolidated in the active runbook: **[`docs/runbooks/DISASTER-RECOVERY-AND-SUCCESSION.md`](runbooks/DISASTER-RECOVERY-AND-SUCCESSION.md)**. See also `CC-091`.

Companion to the mainnet infra migration checklist (`carbon-contractors-mainnet-infra-migration-checklist-2026-08-19`). That checklist covers the testnet → mainnet swap. This doc covers a different question Aaron raised alongside it: if any one piece of the current hosting stack disappears — Vercel gets blocked or shut down, Supabase-the-company becomes unavailable, or Aaron himself is unreachable — does the platform survive, and what's the actual procedure.

Framed as disaster recovery rather than as a decentralization purity exercise, per Aaron's own reframe (2026-08-19): the honest first question for each layer isn't "is this decentralized enough" but "what's the failover, who executes it, how fast, and how does a client find the result."

Written before implementation — this is the plan and the open decisions, not a build log. Cross-reference: `CC-044` (standalone MCP server package, P2, not started), `CC-045` (MCP supply chain / STDIO hardening, becomes mandatory once strangers run their own server copies), `ADR-0001` D4 (`verify-commitments` — DB rows hash to on-chain commitments, the mechanism that makes a Supabase replacement's data checkable rather than blindly trusted).

## The four layers, and which axis each one sits on

Aaron's stated model, which this doc adopts as the frame:

| Layer | Nature | DR question |
| :---- | :---- | :---- |
| Frontend (Vercel/Next.js) | Disposable, cloneable | Can someone stand up a working replacement fast, from the public repo? |
| Base (blockchain) | Already decentralized | Not a gap — no DR needed. |
| Supabase (data) | A database that needs a DR plan | Where does a restored or replacement copy run, and is its data verifiable rather than just trusted? |
| Discoverability | The "how does anyone find the current front door" problem | If the known URL goes dark, what's the failover pointer, who can move it, and does it depend on the same infrastructure it's meant to survive? |

Governance (who holds the HSM, who can turn task creation on/off) is explicitly out of scope for this doc — Aaron has stated that stays centralized by design. This doc is about infrastructure survival, not about redistributing authority.

## 1\. Frontend (Vercel) — disposable/cloneable

**Assessment: closest to solved already**, because the mainnet migration checklist's §3 already enumerates the env vars a clone needs (`NEXT_PUBLIC_BASE_NETWORK`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_ESCROW_CONTRACT`, `NEXT_PUBLIC_BASE_URL`, RPC URL, etc.). What's missing is turning that into a DR runbook rather than a migration checklist.

- [ ] Confirm the repo (public per CC-028/CC-056) contains everything needed to build and deploy standalone — no undocumented Vercel-specific config, no secrets baked in rather than env-supplied.  
- [ ] Write a short "stand up a replacement frontend" runbook: clone repo → set env vars (link to migration checklist §3) → deploy to an alternative host (Netlify, Cloudflare Pages, self-hosted) → repoint DNS.  
- [ ] Decide in advance which alternative host is the "if Vercel goes down" default, so this isn't researched for the first time during an outage.  
- [ ] Confirm this runbook doesn't assume Aaron's personal Vercel/DNS credentials are reachable — see §4, this is really a discoverability dependency wearing a frontend hat.

## 2\. Base (blockchain) — no DR needed

Not a gap. Escrow funds, settlement logic, and (per `ADR-0001`) reputation are already anchored on-chain, independent of Vercel or Supabase being up. Included here only for completeness of the four-layer model, so a future reader doesn't wonder why it's missing.

## 3\. Supabase (database) — needs a DR plan

Two distinct failure scenarios, worth keeping separate because they have different answers:

**Scenario A — Aaron's Supabase instance has a problem, but Supabase-the-company is fine.** Largely covered already: Supabase Pro (`CC-058`) includes daily backups. Open item is just confirming a restore has actually been tested, not only that backups exist.

- [ ] Test-restore a backup at least once before launch; confirm the restore procedure is documented, not just assumed to work.

**Scenario B — Supabase-the-company is the thing that's unavailable.** This is the harder, currently unplanned case, and it's the one that actually matches "infrastructure decentralization" rather than ordinary backup hygiene.

- [ ] Decide whether the DR target for this scenario is self-hosted Postgres via Supabase's own open-source stack (real option — Supabase is built on standard Postgres, not a proprietary format), or a different managed provider.  
- [ ] Document the export/import path from Supabase to that target so it's not designed from scratch mid-incident.  
- [ ] Decide who is trusted to run this replacement backend if Aaron is also unreachable (see §4) — a re-hosted DB with no clear operator is not actually a recovery.  
- [ ] Lean on `ADR-0001` D4 (`verify-commitments`) deliberately here: the reason a replacement backend doesn't require blind trust in whoever stands it up is that every DB row is checkable against its on-chain commitment. This monitor existing and actually running is what turns "someone else's database" into "a database anyone can verify," which is the real decentralization property, not the mere existence of a second copy.

## 4\. Discoverability — DR for "how does anyone find the current front door"

The genuinely unsolved piece — no existing design covers this today. Reframed as DR rather than as an exotic on-chain-registry problem, per Aaron's 2026-08-19 correction: the first-pass answer looks like ordinary failover planning, not new infrastructure.

- [ ] A DNS record Aaron controls, separate from Vercel, that can be repointed at a replacement frontend without depending on Vercel being reachable to do it.  
- [ ] A canonical "if the main site is down, check here" location that does *not* depend on the same infrastructure it's announcing the failure of — candidates: the GitHub repo README (survives a Vercel/DNS outage), an ENS text record on a name Aaron controls, a pinned announcement on a persistent channel (Discord/X) Aaron can update from a device unrelated to the failed infra.  
- [ ] Decide the actual trigger and executor: who declares "Vercel is down, failover now," and do they have access to DNS and the announcement channel independent of the outage. This is where the discoverability problem and the governance/bus-factor problem meet — a DR plan that only Aaron can execute is a DR plan with a single point of failure one layer up.  
- [ ] Once `CC-044` (standalone MCP server package) exists, decide whether MCP clients need their own discoverability story distinct from the human-facing frontend's — a client that only knows `basedhuman.mcp` on Aaron's Vercel deployment has the identical problem as a browser user with a bookmarked URL.

## Sequencing relative to other work

This is DR planning, not a launch gate — none of the above blocks the mainnet migration checklist or CC-039. Reasonable order:

1. Frontend runbook and Supabase Scenario A restore test — cheap, no dependencies, doable now.  
2. Discoverability DNS/announcement-channel decisions — cheap, mostly a decision \+ a few records to set up, doable now.  
3. Supabase Scenario B (self-host target, export path) and the CC-044 MCP client discoverability question — genuinely depend on `CC-044` landing first, so these stay open items until that ticket moves.

## Open items carried forward

- Supabase Scenario B target (self-hosted Postgres vs. alternative managed provider) — undecided.  
- Who besides Aaron can execute the discoverability failover — undecided; intersects with the deliberately-centralized governance model.  
- CC-044's own timeline (currently P2, not started) — this doc's §4 last item and §3 Scenario B both wait on it.

Related: mainnet infra migration checklist, `CC-028`, `CC-044`, `CC-045`, `CC-056`, `CC-058`, `ADR-0001`.  
