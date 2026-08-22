-- inspect-exec-sql.sql — CC-054 reconnaissance, read-only.
--
-- HOW TO RUN
-- Supabase dashboard → SQL Editor → New query → paste → Run.
-- Run each numbered block separately; the editor shows only the last result set
-- when several are run together.
--
-- SAFE: every statement below is a SELECT. Nothing is created, altered or dropped.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Does exec_sql exist, and how is it declared?
--    Expect zero rows if it has already been removed.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT n.nspname                                   AS schema,
       p.proname                                   AS name,
       pg_get_function_identity_arguments(p.oid)    AS args,
       p.prosecdef                                 AS security_definer,  -- true = runs as owner
       pg_get_userbyid(p.proowner)                  AS owner,            -- postgres = full rights
       p.provolatile                               AS volatility,
       COALESCE(p.proacl::text, 'NULL = inherits default/PUBLIC') AS raw_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'exec_sql';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE ANSWER THAT MATTERS — who can EXECUTE it?
--    Any row where grantee is 'anon' or 'PUBLIC' is a live critical finding,
--    because the anon key ships to every browser.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT p.proname                                    AS name,
       pg_get_function_identity_arguments(p.oid)     AS args,
       r.rolname                                    AS grantee,
       has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN (
  SELECT rolname FROM pg_roles
  WHERE rolname IN ('anon', 'authenticated', 'service_role', 'postgres')
) r
WHERE p.proname = 'exec_sql'
  AND n.nspname = 'public'
ORDER BY r.rolname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. GENERALISED — every public-schema function anon or authenticated can run.
--    Cross-check against supabase/migrations/*.sql. Anything here that is not
--    in a migration was created out of band and is untracked. This is the more
--    valuable output: exec_sql is the one we know about, not necessarily the
--    only one.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT p.proname                                 AS name,
       pg_get_function_identity_arguments(p.oid)  AS args,
       p.prosecdef                              AS security_definer,
       pg_get_userbyid(p.proowner)               AS owner,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
    OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY anon_can_execute DESC, p.proname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BONUS, and worth the 10 seconds — did the AUD-001/009 RLS fixes hold?
--    Confirms what the anon role can still reach at table level.
--    `notification_channels` must NOT be anon-readable (migrations 003 and 010).
--    `humans` anon-readable is intentional — the public whitepages — see CC-030.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT c.relname                                        AS object,
       c.relkind                                        AS kind,       -- r=table, v=view
       c.relrowsecurity                                 AS rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT')      AS anon_select,
       has_table_privilege('anon', c.oid, 'INSERT')      AS anon_insert,
       has_table_privilege('anon', c.oid, 'UPDATE')      AS anon_update,
       has_table_privilege('anon', c.oid, 'DELETE')      AS anon_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v')
ORDER BY anon_select DESC, c.relname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Which RLS policies actually exist, for the record.
--
--    NOTE: `qual` is the USING clause only. For INSERT policies the security
--    clause is WITH CHECK, which appears in `with_check` — an INSERT policy
--    showing qual = null is normal, not a finding. Both columns are selected
--    below; an earlier version of this file omitted with_check and was
--    therefore misleading.
--
--    Read alongside block 4. A table with NO policies is only protected if
--    rls_enabled = true. No policies + RLS disabled = grants govern, wide open.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT tablename,
       policyname,
       roles,
       cmd,
       qual        AS using_clause,
       with_check  AS with_check_clause
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The decisive companion to block 5 — is RLS actually switched on?
--    Any table with rls_enabled = false and anon_select = true is readable by
--    anyone holding the anon key, policies or not.
--    Expect: notification_channels NOT anon-readable;
--            humans anon-readable by design (CC-030);
--            tasks NOT directly readable (anon reads tasks_public instead).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT c.relname                                   AS object,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' END AS kind,
       c.relrowsecurity                            AS rls_enabled,
       c.relforcerowsecurity                       AS rls_forced,
       (SELECT count(*) FROM pg_policies pol
         WHERE pol.schemaname = 'public' AND pol.tablename = c.relname) AS policy_count,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
       CASE
         WHEN c.relkind = 'v' THEN 'view — check underlying table'
         WHEN NOT c.relrowsecurity AND has_table_privilege('anon', c.oid, 'SELECT')
           THEN 'WIDE OPEN — RLS off and anon can select'
         WHEN c.relrowsecurity AND (SELECT count(*) FROM pg_policies pol
              WHERE pol.schemaname = 'public' AND pol.tablename = c.relname) = 0
           THEN 'locked (RLS on, no policies = deny all)'
         ELSE 'policy-governed'
       END                                         AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v')
ORDER BY anon_select DESC, c.relname;
