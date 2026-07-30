-- 013_drop_keepalive.sql
--
-- CC-006 — remove the keepalive table and its policy.
--
-- BACKGROUND
-- A `keepalive` table existed in production with an anon SELECT policy, pinged every
-- three days by .github/workflows/keep_alive.yml. It appeared in no migration, so it
-- was created out of band (see CC-057).
--
-- WHY IT IS BEING REMOVED
-- It did not work. Supabase paused the free-tier project regardless of the ping, so the
-- table bought nothing while adding an untracked, anon-readable object to the schema.
-- The real fix for project pausing is the tier decision in CC-058, not a cron job.
--
-- The GitHub Actions workflow is deleted in the same commit. Remove the SUPABASE_URL and
-- SUPABASE_ANON_KEY repository secrets afterwards if nothing else uses them.
--
-- HOW TO RUN
-- Supabase dashboard -> SQL Editor -> paste -> Run. Idempotent; safe if already gone.
-- The SQL Editor does not reliably show RAISE NOTICE, so read the verification SELECT
-- at the end rather than the notices.

BEGIN;

DROP POLICY IF EXISTS "public read" ON public.keepalive;
DROP TABLE IF EXISTS public.keepalive;

COMMIT;


-- ── VERIFICATION ────────────────────────────────────────────────────────────
-- Returns rows, so it is visible in the SQL Editor. Expect ZERO rows.

SELECT c.relname AS still_present
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'keepalive';
