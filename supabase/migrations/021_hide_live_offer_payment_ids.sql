-- 021_hide_live_offer_payment_ids.sql
--
-- Stop publishing the payment_request_id of a task that has not been funded yet.
--
-- WHY THIS EXISTS
--
-- `taskId` on-chain is `keccak256(payment_request_id)` (src/lib/contracts/escrow.ts,
-- `toTaskId`) and `CarbonEscrow.createTask` is permissionless and first-come-first-served:
-- it reverts `TaskAlreadyExists()` for any id already used, and there is no path that
-- frees one. The id itself is 128 bits of `randomBytes(16)` and would be unguessable —
-- except that `tasks_public` publishes it, and `GET /api/tasks` serves that view to
-- unauthenticated callers for the 100 most recent tasks of any status.
--
-- So an observer could poll the public feed, take a `pending` or `accepted` task's id,
-- and call `createTask` on it with 1 unit of USDC (0.000001) plus Base gas before the real
-- agent did. The agent's own `createTask` then reverts permanently. `/api/fund-task`
-- refuses to activate on the worker/amount mismatch, so no money is lost — but the task
-- is dead and has to be re-requested with a fresh id. At Base gas prices that grief costs
-- fractions of a cent per task, needs no authentication, and scales.
--
-- Nothing has been funded yet (`totalLocked` 0, funding path never run), so this is being
-- closed before it can be used rather than after.
--
-- WHY A CASE RATHER THAN DROPPING THE COLUMN
--
-- The exposure window is exactly "a live offer the agent still intends to fund" —
-- `pending` and `accepted`. Once a task is `active` its on-chain task already exists and
-- the id cannot be squatted; once it is `declined`, `lapsed`, `completed`, `disputed` or
-- `expired` it is dead and the agent re-targets with a fresh id, so squatting it costs
-- nobody anything. Publishing the id for those states keeps the public feed able to look
-- a task up on-chain, which is the transparency the view exists for.
--
-- Neither party loses anything: the hiring agent gets the id from `request_human_work`'s
-- own response, and the worker gets it from the authenticated `/api/tasks` path (CC-093),
-- which reads the base table and is unaffected by this view.
--
-- READ THE `tasks_public` LANDMINE IN CLAUDE.md BEFORE TOUCHING THIS.
-- The view deliberately has NO `security_invoker`, so it runs as its owner and bypasses
-- `tasks`'s deny-all RLS. That is the mechanism, not a bug. Setting `security_invoker = true`
-- would break the public feed. Its safety rests entirely on this explicit column list.

CREATE OR REPLACE VIEW tasks_public AS
  SELECT
    id,
    -- NULL while the offer is live and unfunded — see the header.
    CASE
      WHEN status IN ('pending', 'accepted') THEN NULL
      ELSE payment_request_id
    END AS payment_request_id,
    from_agent_wallet,
    to_human_wallet,
    amount_usdc,
    deadline_unix,
    status,
    tx_hash,
    escrow_contract,
    created_at,
    updated_at
  FROM tasks;

-- CREATE OR REPLACE VIEW preserves grants, but 015 sets these explicitly and a silently
-- lost grant on the public feed is a 401 nobody would connect to this migration.
REVOKE ALL ON public.tasks_public FROM anon, authenticated;
GRANT SELECT ON public.tasks_public TO anon;

-- ── verification ────────────────────────────────────────────────────────────
--
-- Expected: live offers hide the id, everything else exposes it, and the column list is
-- otherwise unchanged (11 columns, still no task_description or acceptance_spec).

SELECT
  status,
  count(*)                                          AS rows,
  count(payment_request_id)                         AS ids_exposed,
  count(*) - count(payment_request_id)              AS ids_hidden
FROM tasks_public
GROUP BY status
ORDER BY status;
-- pending / accepted -> ids_exposed = 0
-- everything else    -> ids_hidden  = 0

SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tasks_public';
-- Expect exactly:
--   id, payment_request_id, from_agent_wallet, to_human_wallet, amount_usdc,
--   deadline_unix, status, tx_hash, escrow_contract, created_at, updated_at

-- Then confirm the feed still works, with the ANON key, from outside the editor:
--   curl -s "$SUPABASE_URL/rest/v1/tasks_public?select=*&limit=1" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
-- A 200 with rows (or an empty array) is correct. A 401 with SQLSTATE 42501 means the
-- grant was lost — re-run the GRANT above.
