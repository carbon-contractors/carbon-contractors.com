-- 020_task_idempotency_key.sql
-- CC-046: idempotent request_human_work. An agent retrying a hire after a network
-- failure must get the original task back, not a second task row it might also
-- fund. The key is caller-scoped: (from_agent_wallet, idempotency_key).

ALTER TABLE tasks
  ADD COLUMN idempotency_key        text,
  ADD COLUMN review_window_seconds  integer;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_idempotency_key_length
  CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128);

-- Hard backstop against the concurrent-retry race the TTL lookup cannot close:
-- two simultaneous requests carrying the same key must not both insert. The tool
-- layer treats a 23505 on insert as "fetch the existing row and replay it" (see
-- request_human_work's catch). Note the index outlives the app-layer TTL — a key
-- replayed after the 24h window still returns the original task rather than a
-- second one, which errs toward never double-paying.
CREATE UNIQUE INDEX tasks_agent_idempotency_key_uidx
  ON tasks (from_agent_wallet, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- review_window_seconds is stored so a replay can reconstruct the full v2
-- createTask parameter set from the row alone (it was previously derivable only
-- from the original in-memory request).

-- ── tasks_public: deliberately unchanged ────────────────────────────────────
-- The view (011) has an explicit column list; neither new column is added to it.
-- idempotency_key is agent-chosen and can embed business context — not for the
-- public feed. Stated explicitly because CLAUDE.md requires the list be re-checked
-- whenever tasks gains a column.
