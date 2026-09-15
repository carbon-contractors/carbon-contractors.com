-- 022_worker_sessions.sql
--
-- NOR-322 / ADR-0009 — server-side sessions: sign once at connect, then only
-- when the chain is touched.
--
-- WHY THIS EXISTS
--
-- Every off-chain API call the dashboard made minted its own challenge-response
-- wallet signature (CC-093's proof pattern applied per request instead of per
-- session), so navigating the dashboard prompted signatures indistinguishable,
-- from the worker's seat, from transaction confirmations. ADR-0009 replaces that
-- with a session minted from ONE successful challenge: the wallet signs at
-- connect, off-chain calls ride an opaque token, and the only further prompts
-- are the wallet's own native ones on actual contract writes.
--
-- SHAPE
--
-- The token is 256 bits of randomBytes shown to the client exactly once; this
-- table stores only its SHA-256 hash. A stolen database dump therefore yields
-- no usable session, and revocation is a row update (ADR-0009 D5), not a
-- denylist — which is why this is a table rather than a stateless JWT.
--
-- SCOPES
--
-- `scopes` ships with exactly one value today (`session:full`). It exists so a
-- future worker-side agent delegation (NOR-332 ruling: not engineered as a
-- product, not locked out) is additive rather than a rewrite of the auth
-- primitive. Nothing but the server, via the service role, reads this table.
--
-- A SESSION IS NOT A WALLET (ADR-0009 D3). Nothing here authorises a fund
-- movement, a verdict signature, or a contract-side check. Every on-chain
-- authorisation remains a native wallet prompt.

CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercase-enforced like every wallet column (CC-002).
  wallet text NOT NULL CHECK (wallet = lower(wallet)),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{session:full}',
  -- Human label shown in the dashboard session list ("Dashboard" today; a
  -- delegated agent's name in the reserved future).
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_wallet_idx ON public.sessions (wallet);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- No policies at all: the server reads and writes via the service role, which
-- bypasses RLS. Zero policies deny every command to anon/authenticated even
-- before the grants below are considered.
--
-- Supabase grants ALL on new tables to anon and authenticated by default;
-- 015 (CC-062) removes them per table and this follows that rule in the same
-- migration that creates the table.
REVOKE ALL ON public.sessions FROM anon, authenticated;

-- ── verification ────────────────────────────────────────────────────────────
--
-- Expected: RLS enabled, zero policies, zero grants to anon/authenticated.

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'sessions';
-- Expect: rls_enabled = true, policies = 0

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'sessions'
ORDER BY grantee, privilege_type;
-- Expect: rows only for the owner role (service_role bypasses via role
-- membership) — no anon, no authenticated.
