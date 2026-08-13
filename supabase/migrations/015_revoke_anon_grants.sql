-- 015_revoke_anon_grants.sql
--
-- CC-062 — remove Supabase's default table-level grants from `anon` and `authenticated`,
-- so RLS is not the only thing standing between the public anon key and real personal data.
--
-- WHY THIS EXISTS
-- Supabase applies `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated` by
-- default. Measured against production on 2026-07-30, every table reported
-- anon_sel/anon_ins/anon_upd/anon_del = true. So the only thing denying access is row-level
-- security, and on `waitlist` that is real third-party email addresses protected by exactly
-- one mechanism.
--
-- NOTHING HERE IS CURRENTLY EXPLOITABLE. `waitlist`, `tasks`, `used_nonces` and
-- `mcp_challenges` have RLS enabled with zero policies, which denies every command to every
-- role regardless of the grant. `notification_channels`'s three policies are all scoped to
-- `authenticated`, never `anon`. This migration removes a layer that currently does nothing
-- except sit ready to matter the moment RLS is touched — one `DISABLE ROW LEVEL SECURITY`,
-- or one over-broad policy, and the emails are readable with no second barrier. Migrations
-- on this project are applied by hand in the SQL editor with no review (CC-057), which is
-- precisely that scenario.
--
-- SERVER-SIDE WRITES ARE UNAFFECTED. Everything in `src/lib/db/` that writes uses the
-- service role key, which bypasses both grants and RLS.

-- ── PII and internal tables: no anon or authenticated access at all ──────────

REVOKE ALL ON public.waitlist FROM anon, authenticated;
REVOKE ALL ON public.notification_channels FROM anon, authenticated;
REVOKE ALL ON public.used_nonces FROM anon, authenticated;
REVOKE ALL ON public.mcp_challenges FROM anon, authenticated;

-- ── tasks: revoke the base table, keep the public view working ───────────────
--
-- READ THE `tasks_public` LANDMINE IN CLAUDE.md BEFORE TOUCHING THIS.
--
-- Anon reads the `tasks_public` view, never `tasks` directly. That view deliberately has NO
-- `security_invoker`, so it executes as its owner — which means it is the *owner's* privileges
-- on `tasks` that matter, not the caller's. Revoking anon's grant on the base table therefore
-- does not affect the view. This is standard Postgres view behaviour and it is the same
-- mechanism that already lets the view bypass `tasks`'s deny-all RLS.
--
-- Verify the public task feed still returns rows after applying this (see the check below).
-- Do NOT "fix" the view by setting `security_invoker = true` — that would break the feed.

REVOKE ALL ON public.tasks FROM anon, authenticated;

-- ── humans: keep anon SELECT — it is the public whitepages, deliberately ─────
--
-- CC-030 confirmed anon read on `humans` is intentional. Revoke the write verbs anon should
-- never have had, and re-grant the SELECT the whitepages depends on.
--
-- `authenticated` is left alone here on purpose: migration 005's `humans_update_self` policy
-- targets that role. The policy is dormant today (nothing mints a Supabase JWT carrying a
-- `wallet_address` claim), but if wallet-based Supabase Auth is ever wired up — CC-021
-- option (b) — revoking the grant now would make that policy fail for a reason nobody would
-- think to look for.

REVOKE ALL ON public.humans FROM anon;
GRANT SELECT ON public.humans TO anon;

-- ── tasks_public: the view anon is supposed to read ──────────────────────────

REVOKE ALL ON public.tasks_public FROM anon, authenticated;
GRANT SELECT ON public.tasks_public TO anon;

-- ── verification ────────────────────────────────────────────────────────────
--
-- Expected:
--   waitlist, notification_channels, used_nonces, mcp_challenges, tasks
--     → every anon_* and auth_* column false
--   humans      → anon_sel true, anon_ins/upd/del false (authenticated untouched)
--   tasks_public → anon_sel true, everything else false
--
-- Block 4 of scripts/audit/inspect-live-schema.sql covers the same ground more fully.

SELECT
  c.relname AS object,
  has_table_privilege('anon',          'public.' || c.relname, 'SELECT') AS anon_sel,
  has_table_privilege('anon',          'public.' || c.relname, 'INSERT') AS anon_ins,
  has_table_privilege('anon',          'public.' || c.relname, 'UPDATE') AS anon_upd,
  has_table_privilege('anon',          'public.' || c.relname, 'DELETE') AS anon_del,
  has_table_privilege('authenticated', 'public.' || c.relname, 'SELECT') AS auth_sel,
  has_table_privilege('authenticated', 'public.' || c.relname, 'INSERT') AS auth_ins,
  has_table_privilege('authenticated', 'public.' || c.relname, 'UPDATE') AS auth_upd,
  has_table_privilege('authenticated', 'public.' || c.relname, 'DELETE') AS auth_del
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'waitlist', 'notification_channels', 'used_nonces', 'mcp_challenges',
    'tasks', 'tasks_public', 'humans'
  )
ORDER BY c.relname;

-- Then confirm the public task feed still works, with the ANON key, from outside the editor:
--   curl -s "$SUPABASE_URL/rest/v1/tasks_public?select=*&limit=1" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
-- A 200 with rows (or an empty array if there genuinely are no tasks) is correct.
-- A 401/403 with SQLSTATE 42501 means the view grant was lost — re-run the GRANT above.
