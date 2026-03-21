-- 005_auth_scoped_rls.sql
-- NOR-175: Add authenticated-user-scoped write policies.
--
-- Migration 003 already dropped all permissive anon write policies.
-- Server-side writes use service_role (bypasses RLS).
--
-- These policies prepare for future client-side authenticated flows
-- where a user's JWT contains their wallet address as sub/claim.
-- Until wallet-based auth is wired (Phase 6), these policies are
-- dormant — no authenticated sessions exist yet.

-- ── humans: authenticated users can update only their own record ──────────

CREATE POLICY "humans_update_self" ON humans
  FOR UPDATE TO authenticated
  USING (wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address')
  WITH CHECK (wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address');

-- ── notification_channels: authenticated users manage only their own ──────

CREATE POLICY "notification_channels_insert_self" ON notification_channels
  FOR INSERT TO authenticated
  WITH CHECK (
    contractor_id IN (
      SELECT id FROM humans
      WHERE wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address'
    )
  );

CREATE POLICY "notification_channels_update_self" ON notification_channels
  FOR UPDATE TO authenticated
  USING (
    contractor_id IN (
      SELECT id FROM humans
      WHERE wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address'
    )
  );

CREATE POLICY "notification_channels_delete_self" ON notification_channels
  FOR DELETE TO authenticated
  USING (
    contractor_id IN (
      SELECT id FROM humans
      WHERE wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address'
    )
  );
