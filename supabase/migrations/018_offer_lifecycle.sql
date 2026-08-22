-- 018_offer_lifecycle.sql
-- CC-094 / ADR-0005: the offer stage between request_human_work and funding.
-- New task states 'accepted', 'declined', 'lapsed', plus the agent-set offer
-- expiry (bounded 15 minutes to 7 days in the app layer, ADR-0005 D4).
--
-- No contract change and no money moves at offer time — the offer is entirely
-- off-chain (ADR-0005 D2). Migration 009's immutability trigger needs no
-- change: it fires on any non-pending status, and 'accepted' is exactly when
-- the worker's consent makes the offer fields worth freezing. 'declined' and
-- 'lapsed' are terminal, so nothing mutates past them anyway.

-- When a pending offer lapses. Null on auto-accepted rows (no offer was made)
-- and on anything past the offer stage.
ALTER TABLE tasks ADD COLUMN offer_expiry_unix BIGINT;

-- Widen the status CHECK from migration 001 for the offer states.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (
  status IN ('pending', 'accepted', 'declined', 'lapsed', 'active', 'completed', 'disputed', 'expired')
);

-- Partial index for the inline lapse sweep, which targets exactly these rows.
CREATE INDEX IF NOT EXISTS idx_tasks_offer_expiry
  ON tasks (offer_expiry_unix)
  WHERE status IN ('pending', 'accepted') AND offer_expiry_unix IS NOT NULL;

-- tasks_public (migration 011) keeps its existing column list: offer_expiry_unix
-- is deliberately NOT exposed there. Its safety rests entirely on that explicit
-- list, so it only changes when a caller genuinely needs the column publicly.
