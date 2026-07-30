-- 012_restrict_exec_sql.sql
--
-- CC-054 — lock down any arbitrary-SQL helper function reachable via PostgREST.
--
-- BACKGROUND
-- An `exec_sql` RPC exists on this project but appears in no migration, so it was
-- created out of band (almost certainly to apply migrations conveniently) and its
-- access level was never recorded anywhere.
--
-- WHY IT MATTERS
-- A function that executes arbitrary SQL is the most dangerous object that can exist
-- in a Supabase project. If it is SECURITY DEFINER and the `anon` role can execute it,
-- then the public anon key -- which ships to every browser -- grants full read/write
-- over every table, bypassing every RLS policy added in migrations 003, 005, 010 and
-- 011, and exposing the real email addresses in `waitlist`.
--
-- WHAT THIS DOES
-- Revokes EXECUTE on every `exec_sql` overload from PUBLIC, anon and authenticated,
-- leaving it available to service_role only. Restricting to service_role adds no new
-- risk, because service_role already bypasses RLS by design.
--
-- Idempotent and safe to run when the function does not exist.
--
-- HOW TO RUN
-- There is no Supabase CLI configured on this project (no supabase/config.toml), so
-- paste this into the dashboard SQL Editor and Run.
--
-- IMPORTANT: the SQL Editor does not reliably surface RAISE NOTICE output, so the
-- notices below may not appear. The verification SELECT at the end of this file is
-- what confirms the result -- read that, not the notices.
--
-- NOTE ON THE STRONGER FIX
-- Revoking is the conservative option: it closes the exposure without breaking a
-- migration workflow that may depend on the function. Dropping it entirely is
-- stronger, and nothing in the tracked codebase calls it (verified by grep across
-- src/, scripts/ and supabase/). If migrations are applied through the Supabase CLI
-- or SQL editor instead, uncomment the DROP block at the bottom and remove the helper.

BEGIN;

DO $$
DECLARE
  fn        record;
  found_any boolean := false;
BEGIN
  FOR fn IN
    SELECT n.nspname AS schema_name,
           p.proname AS fn_name,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS is_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'exec_sql'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    found_any := true;

    RAISE NOTICE
      'CC-054: restricting %.%(%) [security_definer=%]',
      fn.schema_name, fn.fn_name, fn.args, fn.is_security_definer;

    -- Order matters: revoke from PUBLIC first, since role grants can be inherited
    -- through it. Then revoke the two roles reachable with a browser-side key.
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      fn.schema_name, fn.fn_name, fn.args
    );
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM anon',
      fn.schema_name, fn.fn_name, fn.args
    );
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.%I(%s) FROM authenticated',
      fn.schema_name, fn.fn_name, fn.args
    );

    -- Server-side only. The service role key never leaves the server.
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role',
      fn.schema_name, fn.fn_name, fn.args
    );
  END LOOP;

  IF NOT found_any THEN
    RAISE NOTICE
      'CC-054: no exec_sql function found — nothing to restrict. Recorded as verified.';
  END IF;
END
$$;

COMMIT;


-- ── VERIFICATION ────────────────────────────────────────────────────────────
-- This runs automatically and RETURNS ROWS, so it is visible in the SQL Editor
-- even though the notices above may not be. Read this output.
--
-- PASS looks like either:
--   * zero rows                                    -> no exec_sql exists at all
--   * rows where anon_can_execute = false          -> locked down correctly
-- FAIL is any row where anon_can_execute = true.

SELECT p.proname                                  AS name,
       pg_get_function_identity_arguments(p.oid)    AS args,
       p.prosecdef                                AS security_definer,
       pg_get_userbyid(p.proowner)                 AS owner,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'exec_sql'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');

-- Grants are the authority, but the end-to-end test is what actually counts,
-- because it also proves PostgREST is not exposing the function some other way.
-- Run scripts/audit/probe-exec-sql.mjs, or from a terminal:
--
--   curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"sql":"select 1"}'
--
-- Expect 404 (not exposed) or 401/403 (permission denied). A 200 is a failure.


-- ── STRONGER FIX (optional) ─────────────────────────────────────────────────
-- Uncomment to remove the helper entirely rather than merely restricting it.
-- Nothing in the tracked codebase calls it.
--
-- DO $$
-- DECLARE fn record;
-- BEGIN
--   FOR fn IN
--     SELECT n.nspname AS schema_name, p.proname AS fn_name,
--            pg_get_function_identity_arguments(p.oid) AS args
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE p.proname = 'exec_sql'
--       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
--   LOOP
--     RAISE NOTICE 'CC-054: dropping %.%(%)', fn.schema_name, fn.fn_name, fn.args;
--     EXECUTE format('DROP FUNCTION %I.%I(%s)', fn.schema_name, fn.fn_name, fn.args);
--   END LOOP;
-- END $$;
