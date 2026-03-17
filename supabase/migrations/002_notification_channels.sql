-- 002_notification_channels.sql
-- Notification channel registry for contractors.
-- Supports email, webhook, telegram, discord.
-- accepts_auto_booking enables agent-to-agent hiring without human approval.

CREATE TABLE IF NOT EXISTS notification_channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('email', 'webhook', 'telegram', 'discord')),
  address       TEXT NOT NULL,
  accepts_auto_booking BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One channel per type per contractor
  UNIQUE (contractor_id, type)
);

-- Index for finding auto-bookable contractors quickly
CREATE INDEX idx_notification_channels_auto_booking
  ON notification_channels (accepts_auto_booking)
  WHERE accepts_auto_booking = true;

-- RLS: permissive for now (tighten in Phase 6)
ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_notification_channels"
  ON notification_channels FOR SELECT TO anon
  USING (true);

CREATE POLICY "anon_insert_notification_channels"
  ON notification_channels FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "anon_update_notification_channels"
  ON notification_channels FOR UPDATE TO anon
  USING (true);
