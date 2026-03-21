-- 006_used_nonces.sql
-- NOR-176: Replay protection for wallet signature registration.
-- Stores consumed nonces with a TTL for automatic cleanup.

CREATE TABLE IF NOT EXISTS used_nonces (
  nonce       TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for TTL cleanup (delete nonces older than 1 hour)
CREATE INDEX idx_used_nonces_consumed_at ON used_nonces (consumed_at);

-- RLS: no public access. Only service_role writes/reads nonces.
ALTER TABLE used_nonces ENABLE ROW LEVEL SECURITY;
