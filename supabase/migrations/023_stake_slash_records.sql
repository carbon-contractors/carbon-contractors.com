-- 023_stake_slash_records.sql
--
-- NOR-330 / CC-101 — the link from a stake slash back to the dispute that
-- caused it.
--
-- WHY THIS EXISTS
--
-- ReputationStake's Slashed event is (worker, amount, remaining) — the chain
-- records THAT a worker was slashed and by how much, but not WHY or for which
-- task. The knowledge exists only at the moment of resolution: the owner
-- slashes as part of resolving a specific dispute (ADR-0001's manual tier).
-- Unless that knowledge is written down when it exists, a worker sees money
-- gone with no traceable reason — which is exactly NOR-330.
--
-- So this table records the resolution-time facts: who was slashed, how much,
-- for which task (when the dispute was task-bound), and the on-chain tx that
-- did it. It is an attestation by the platform, not a chain fact — the tx_hash
-- is unique, so a slash can only ever be recorded once, and anyone can verify
-- the recorded amount against the Slashed event it points at.
--
-- Rows are written by the platform (service role) via the owner's recorder
-- script at resolution time. Reads are public-by-endpoint: /api/reputation
-- serves a worker's own rows next to the on-chain slashed total, which is
-- already public via getWorkerInfo.

CREATE TABLE public.stake_slashes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL CHECK (wallet = lower(wallet)),
  amount_usdc numeric NOT NULL CHECK (amount_usdc > 0),
  -- The disputed task, when the slash was task-bound. Nullable: a slash could
  -- in principle arise from a non-task cause, and an unrecordable link must
  -- not block recording the slash itself.
  payment_request_id text,
  -- Unique: one on-chain slash, one row. Re-running the recorder is a no-op
  -- conflict, not a duplicate.
  tx_hash text NOT NULL UNIQUE,
  slashed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stake_slashes_wallet_idx ON public.stake_slashes (wallet);

ALTER TABLE public.stake_slashes ENABLE ROW LEVEL SECURITY;

-- Same posture as every internal table (015, CC-062): the server reads and
-- writes via the service role, which bypasses RLS; zero policies deny
-- anon/authenticated regardless of grants; the grants are revoked in the same
-- migration that creates the table.
REVOKE ALL ON public.stake_slashes FROM anon, authenticated;

-- ── verification ────────────────────────────────────────────────────────────

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'stake_slashes';
-- Expect: rls_enabled = true, policies = 0

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'stake_slashes'
ORDER BY grantee, privilege_type;
-- Expect: rows only for postgres/service_role — no anon, no authenticated.
