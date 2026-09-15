-- 024_offer_expiry_reminder.sql (CC-095)
--
-- Once-only marker for the offer_expiring reminder (CC-095's "offer about to
-- expire" event). A boolean column, not a timestamp: the reminder fires at most
-- once per offer, and the time it fired at is already reconstructable from the
-- cron run window and the offer's own expiry — a precise timestamp would be
-- retention noise with no reader.
--
-- Nullable boolean so existing rows mean "not yet reminded" without a
-- table rewrite; partial index over the cron's candidate set (pending offers
-- with an expiry still in the future) so the hourly scan stays an index probe.

ALTER TABLE tasks ADD COLUMN offer_reminder_sent BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_tasks_offer_reminder
  ON tasks (offer_expiry_unix)
  WHERE status = 'pending' AND offer_reminder_sent IS NOT TRUE;

-- tasks_public (migration 011) keeps its column list: an offer's expiry is the
-- worker's own clock, but the reminder marker is delivery bookkeeping and stays
-- out of the public view.
