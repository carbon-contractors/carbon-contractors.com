-- 014_normalize_wallet_casing.sql
--
-- CC-002 — humans.wallet and tasks.{to_human_wallet,from_agent_wallet} are stored
-- mixed-case (whatever casing the client happened to send) while every read path
-- queries lowercase. Every registered worker 404s on profile lookup as a result.
--
-- BACKGROUND
-- src/app/api/register/route.ts inserted the raw EIP-55 checksummed address; every
-- read (src/lib/db/whitepages.ts, src/lib/db/tasks.ts) queried `.toLowerCase()`. Both
-- sides of the app code are now fixed to write lowercase (same commit as this
-- migration) — this migration backfills existing rows and adds a CHECK constraint so
-- it cannot regress silently again.
--
-- THE TRAP: migration 009 added a trigger that raises an exception if
-- to_human_wallet/from_agent_wallet change on a task whose status is not 'pending'.
-- A same-value-different-case UPDATE still counts as a change (Postgres TEXT
-- comparison is case-sensitive), so the tasks backfill below disables that trigger
-- for the duration of the backfill and re-enables it immediately after. Once the CHECK
-- constraint is in place, no future write can ever reintroduce mixed case, so the
-- trigger's case-sensitive comparison stays correct going forward.
--
-- HOW TO RUN
-- Supabase dashboard -> SQL Editor -> paste -> Run. Idempotent; safe to re-run.
-- Ask before running this against production — it writes to `humans` and `tasks`.

BEGIN;

-- ── humans ───────────────────────────────────────────────────────────────────
UPDATE humans
SET wallet = lower(wallet)
WHERE wallet <> lower(wallet);

ALTER TABLE humans
  DROP CONSTRAINT IF EXISTS humans_wallet_lowercase;
ALTER TABLE humans
  ADD CONSTRAINT humans_wallet_lowercase CHECK (wallet = lower(wallet));

-- ── tasks ────────────────────────────────────────────────────────────────────
ALTER TABLE tasks DISABLE TRIGGER trg_prevent_task_mutation;

UPDATE tasks
SET
  to_human_wallet = lower(to_human_wallet),
  from_agent_wallet = lower(from_agent_wallet)
WHERE to_human_wallet <> lower(to_human_wallet)
   OR from_agent_wallet <> lower(from_agent_wallet);

ALTER TABLE tasks ENABLE TRIGGER trg_prevent_task_mutation;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_to_human_wallet_lowercase;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_to_human_wallet_lowercase CHECK (to_human_wallet = lower(to_human_wallet));

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_from_agent_wallet_lowercase;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_from_agent_wallet_lowercase CHECK (from_agent_wallet = lower(from_agent_wallet));

COMMIT;


-- ── VERIFICATION ────────────────────────────────────────────────────────────
-- Returns rows, so it is visible in the SQL Editor. Expect ZERO rows from both.

SELECT 'humans' AS table_name, wallet AS mixed_case_value
FROM humans
WHERE wallet <> lower(wallet)
UNION ALL
SELECT 'tasks (to_human_wallet)', to_human_wallet
FROM tasks
WHERE to_human_wallet <> lower(to_human_wallet)
UNION ALL
SELECT 'tasks (from_agent_wallet)', from_agent_wallet
FROM tasks
WHERE from_agent_wallet <> lower(from_agent_wallet);
