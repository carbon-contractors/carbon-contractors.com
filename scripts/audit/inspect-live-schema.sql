-- inspect-live-schema.sql — CC-054 / CC-006 / CC-057. READ-ONLY.
--
-- WHY THIS EXISTS
-- `scripts/audit/inspect-exec-sql.sql` is six separate blocks, and the dashboard SQL
-- Editor shows only the LAST result set when several statements run together. So that
-- file has to be run six times, and in practice it gets run once and misread.
--
-- This is the same information as ONE statement returning ONE result set. Paste, Run,
-- copy the whole grid back. Every row is a SELECT against a catalog view; nothing is
-- created, altered or dropped.
--
-- It also answers two things the anon-key probes physically cannot:
--   * whether `exec_sql` still EXISTS (anon getting 404 only proves anon cannot reach it)
--   * the anon INSERT/UPDATE/DELETE posture (probing that from outside would mean
--     attempting a real write against production)
--
-- HOW TO RUN
-- Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- HOW TO READ IT
-- Sections come back in order. The ones that matter most:
--   1_exec_sql      any row at all = the function still exists. anon_exec = true is critical.
--   2_anon_exec_fn  every function a browser key can call. Cross-check against migrations;
--                   anything here that is not in supabase/migrations/ is untracked drift.
--   3_keepalive     expect ZERO rows. Any row means migration 013 did not take.
--   4_object_acl    anon_ins/upd/del must be false everywhere. anon_sel true is expected
--                   on humans and tasks_public only (both deliberate).
--   6_tasks_public  the column list is the ONLY thing keeping task_description private.
--                   task_description must NOT appear.

WITH
-- ── 1. Does exec_sql still exist, and who can execute it? ────────────────────
exec_sql AS (
  SELECT '1_exec_sql'                                             AS section,
         n.nspname || '.' || p.proname                             AS name,
         pg_get_function_identity_arguments(p.oid)                 AS detail_a,
         'secdef=' || p.prosecdef ||
           ' owner=' || pg_get_userbyid(p.proowner)                AS detail_b,
         'anon_exec=' || has_function_privilege('anon', p.oid, 'EXECUTE') ||
           ' authed_exec=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') ||
           ' service_exec=' || has_function_privilege('service_role', p.oid, 'EXECUTE') AS detail_c,
         COALESCE(p.proacl::text, 'NULL = inherits default/PUBLIC') AS detail_d
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'exec_sql'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
),

-- ── 2. Every public function a browser-side key can execute — drift surface ──
anon_exec_fn AS (
  SELECT '2_anon_exec_fn'                                          AS section,
         p.proname                                                 AS name,
         pg_get_function_identity_arguments(p.oid)                 AS detail_a,
         'secdef=' || p.prosecdef ||
           ' owner=' || pg_get_userbyid(p.proowner)                AS detail_b,
         'anon_exec=' || has_function_privilege('anon', p.oid, 'EXECUTE') ||
           ' authed_exec=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') AS detail_c,
         p.prokind::text                                           AS detail_d
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
),

-- ── 3. keepalive — authoritative answer for migration 013 ───────────────────
keepalive AS (
  SELECT '3_keepalive'                                             AS section,
         c.relname                                                 AS name,
         c.relkind::text                                           AS detail_a,
         'STILL PRESENT — migration 013 did not take'               AS detail_b,
         ''::text                                                  AS detail_c,
         ''::text                                                  AS detail_d
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'keepalive'
),

-- ── 4. Table/view level: RLS on? policies? what can anon actually do? ───────
object_acl AS (
  SELECT '4_object_acl'                                            AS section,
         c.relname                                                 AS name,
         CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                        WHEN 'm' THEN 'matview' ELSE c.relkind::text END AS detail_a,
         'rls=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity ||
           ' policies=' || (SELECT count(*) FROM pg_policies pol
                            WHERE pol.schemaname = 'public'
                              AND pol.tablename = c.relname)       AS detail_b,
         'anon_sel=' || has_table_privilege('anon', c.oid, 'SELECT') ||
           ' anon_ins=' || has_table_privilege('anon', c.oid, 'INSERT') ||
           ' anon_upd=' || has_table_privilege('anon', c.oid, 'UPDATE') ||
           ' anon_del=' || has_table_privilege('anon', c.oid, 'DELETE')  AS detail_c,
         CASE
           WHEN c.relkind = 'v' THEN 'view — inherits owner rights unless security_invoker'
           WHEN NOT c.relrowsecurity AND has_table_privilege('anon', c.oid, 'SELECT')
             THEN 'WIDE OPEN — RLS off and anon can select'
           WHEN c.relrowsecurity AND (SELECT count(*) FROM pg_policies pol
                WHERE pol.schemaname = 'public' AND pol.tablename = c.relname) = 0
             THEN 'RLS on, no policies = deny all rows (grant may still exist)'
           ELSE 'policy-governed'
         END                                                       AS detail_d
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm')
),

-- ── 5. The policies themselves. USING and WITH CHECK are different clauses. ──
policies AS (
  SELECT '5_policy'                                                AS section,
         tablename                                                 AS name,
         policyname                                                AS detail_a,
         cmd || ' roles=' || roles::text                            AS detail_b,
         'using=' || COALESCE(qual, '(none)')                       AS detail_c,
         'with_check=' || COALESCE(with_check, '(none)')            AS detail_d
  FROM pg_policies
  WHERE schemaname = 'public'
),

-- ── 6. tasks_public column list — the whole safety mechanism (migration 011) ─
tasks_public_cols AS (
  SELECT '6_tasks_public'                                          AS section,
         a.attname                                                 AS name,
         format_type(a.atttypid, a.atttypmod)                       AS detail_a,
         'ordinal=' || a.attnum                                     AS detail_b,
         CASE WHEN a.attname = 'task_description'
              THEN 'LEAK — task_description must not be in this view'
              ELSE 'ok' END                                        AS detail_c,
         ''::text                                                  AS detail_d
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'tasks_public'
    AND a.attnum > 0 AND NOT a.attisdropped
),

-- ── 7. Does the view bypass RLS on purpose? (see the CLAUDE.md landmine) ────
view_opts AS (
  SELECT '7_view_options'                                          AS section,
         c.relname                                                 AS name,
         COALESCE(array_to_string(c.reloptions, ', '), '(no reloptions)') AS detail_a,
         CASE WHEN COALESCE(array_to_string(c.reloptions, ','), '') LIKE '%security_invoker=true%'
              THEN 'security_invoker=TRUE — view now hits the deny-all policy set; public task feed is BROKEN'
              ELSE 'security_invoker not set — runs as owner, bypasses tasks RLS (INTENDED, leave it)'
         END                                                       AS detail_b,
         pg_get_userbyid(c.relowner)                                AS detail_c,
         ''::text                                                  AS detail_d
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v'
),

-- ── 8. Row counts and waitlist age spread. Aggregates only — no addresses. ──
row_counts AS (
  SELECT '8_counts' AS section, 'humans' AS name, count(*)::text AS detail_a,
         ''::text AS detail_b, ''::text AS detail_c, ''::text AS detail_d FROM public.humans
  UNION ALL SELECT '8_counts', 'tasks', count(*)::text, '', '', '' FROM public.tasks
  UNION ALL SELECT '8_counts', 'notification_channels', count(*)::text, '', '', ''
    FROM public.notification_channels
  UNION ALL
  SELECT '8_counts', 'waitlist', count(*)::text,
         'earliest=' || COALESCE(min(created_at)::text, 'n/a'),
         'latest='   || COALESCE(max(created_at)::text, 'n/a'),
         'distinct_days=' || count(DISTINCT created_at::date)
  FROM public.waitlist
)

SELECT * FROM exec_sql
UNION ALL SELECT * FROM anon_exec_fn
UNION ALL SELECT * FROM keepalive
UNION ALL SELECT * FROM object_acl
UNION ALL SELECT * FROM policies
UNION ALL SELECT * FROM tasks_public_cols
UNION ALL SELECT * FROM view_opts
UNION ALL SELECT * FROM row_counts
ORDER BY section, name;
