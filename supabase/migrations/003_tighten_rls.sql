-- 003_tighten_rls.sql
-- Restrict anon role to read-only on all tables.
-- Server-side writes now use the service_role key (bypasses RLS).

-- ── Drop permissive anon write policies ─────────────────────────────────────

DROP POLICY IF EXISTS "humans_write_anon" ON humans;
DROP POLICY IF EXISTS "tasks_all_anon" ON tasks;
DROP POLICY IF EXISTS "anon_insert_notification_channels" ON notification_channels;
DROP POLICY IF EXISTS "anon_update_notification_channels" ON notification_channels;

-- ── Add read-only policy for tasks (humans + notification_channels already
--    have SELECT policies from migrations 001 + 002) ─────────────────────────

CREATE POLICY "tasks_read_anon" ON tasks
  FOR SELECT TO anon USING (true);
