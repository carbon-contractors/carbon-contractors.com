-- 024_accepted_description_hash.sql
-- CC-084 acceptance criterion 5, second half: "Prose edits are append-only and the
-- accepted version is pinned to the worker's acceptance."
--
-- Migration 016 built the append-only half (task_description_history, ADR-0001
-- Amendment 2 A2.1) and its comment promised "a worker who re-reads the brief
-- mid-job must be able to see that it changed since they accepted" — but nothing
-- recorded WHICH prose version the worker accepted, and no worker surface ever
-- compared current against it. This migration supplies the pin.
--
-- The pin is a COMMITMENT, not content: keccak256 of the task_description bytes at
-- the moment of acceptance, same idiom as specHash (no canonicalisation — the
-- platform's own string is hashed). Being a commitment means:
--   * it survives the CC-087 prune alongside spec_hash (deleting the pin would be
--     deleting the record of what was agreed; a hash reveals nothing);
--   * it never leaks the prose (ADR-0002 D2);
--   * it can live on tasks with no retention cost.
--
-- No backfill: zero tasks have ever been funded (escrow holds 0 USDC, the funding
-- path has never run — same state that justified no schema_version bump on
-- 2026-08-26). Existing accepted/active rows keep pin NULL, which the app layer
-- treats as "pinned at creation, unchanged" for auto-booked tasks created before
-- this migration, and the drift comparison simply never fires on them.

-- ── The pin column ──────────────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN accepted_description_hash text;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_accepted_description_hash_format
  CHECK (
    accepted_description_hash IS NULL
    OR accepted_description_hash ~ '^0x[0-9a-f]{64}$'
  );

-- ── Immutability: pin once, never move ──────────────────────────────────────
-- The pin is settable exactly once — at worker acceptance (or at creation for an
-- auto-booked task, where pre-authorisation is consent, ADR-0005 D3) — and never
-- afterward. The goalpost property this column exists to provide: the version the
-- worker agreed to cannot silently change after the fact. This trigger replaces
-- the function from 019, carrying every prior branch forward unchanged.

CREATE OR REPLACE FUNCTION prevent_task_mutation() RETURNS trigger AS $$
BEGIN
  -- The prune transition (CC-087). NEW is the pruned row.
  IF NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL THEN
    IF OLD.status NOT IN ('completed', 'expired') THEN
      RAISE EXCEPTION 'Cannot prune task content on a non-terminal task (status: %)', OLD.status;
    END IF;
    IF NEW.acceptance_spec IS NOT NULL
    OR NEW.spec_schema_version IS NOT NULL
    OR NEW.spec_hash IS DISTINCT FROM OLD.spec_hash
    OR NEW.task_description IS DISTINCT FROM ''
    OR NEW.content_purge_rule IS NULL
    THEN
      RAISE EXCEPTION 'Malformed prune: preimages must be cleared, commitments preserved (CC-087)';
    END IF;
  ELSIF NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at THEN
    RAISE EXCEPTION 'content_purged_at is settable once and cannot be cleared or moved (CC-087)';
  END IF;

  -- Spec commitment: immutable from creation (CC-084), except the prune above.
  IF (NEW.acceptance_spec     IS DISTINCT FROM OLD.acceptance_spec
  OR NEW.spec_hash            IS DISTINCT FROM OLD.spec_hash
  OR NEW.spec_schema_version  IS DISTINCT FROM OLD.spec_schema_version)
  AND NOT (NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL)
  THEN
    RAISE EXCEPTION 'Cannot modify the acceptance spec once a task row exists (CC-084)';
  END IF;

  -- Prose pin (CC-084 criterion 5): settable once, never movable, never clearable.
  -- NULL → hash is the acceptance moment. hash → anything else is goalpost-moving.
  IF OLD.accepted_description_hash IS NOT NULL
  AND NEW.accepted_description_hash IS DISTINCT FROM OLD.accepted_description_hash THEN
    RAISE EXCEPTION 'Cannot modify the accepted description hash once it is pinned (CC-084)';
  END IF;

  -- No content returns to a pruned task.
  IF OLD.content_purged_at IS NOT NULL THEN
    IF NEW.task_description IS DISTINCT FROM OLD.task_description
    OR NEW.content_purge_rule IS DISTINCT FROM OLD.content_purge_rule
    THEN
      RAISE EXCEPTION 'Cannot restore content to a pruned task (CC-087)';
    END IF;
  END IF;

  -- funded_at: settable once, then locked (018, unchanged).
  IF OLD.funded_at IS NOT NULL AND NEW.funded_at IS DISTINCT FROM OLD.funded_at THEN
    RAISE EXCEPTION 'Cannot modify funded_at once it is set (CC-092)';
  END IF;

  -- Unchanged from 009.
  IF OLD.status != 'pending' THEN
    IF NEW.to_human_wallet   IS DISTINCT FROM OLD.to_human_wallet
    OR NEW.from_agent_wallet IS DISTINCT FROM OLD.from_agent_wallet
    OR NEW.amount_usdc       IS DISTINCT FROM OLD.amount_usdc
    OR NEW.deadline_unix     IS DISTINCT FROM OLD.deadline_unix
    OR NEW.payment_request_id IS DISTINCT FROM OLD.payment_request_id
    THEN
      RAISE EXCEPTION 'Cannot modify immutable fields on a non-pending task (status: %)', OLD.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── The prune RPC: the pin outlives the prose ───────────────────────────────
-- A commitment, like spec_hash. The task_description it was computed from is
-- cleared; the hash that says "this is what was agreed" stays, so the deletion
-- record remains meaningful and the audit story stays complete (ADR-0002 D6 —
-- deleting the preimage satisfies erasure while the commitment stays meaningful).
-- Replaces the function from 019; every other line is carried forward.

CREATE OR REPLACE FUNCTION prune_task_content(
  p_task_id        uuid,
  p_rule_version   text,
  p_window_seconds integer
) RETURNS jsonb
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t             tasks%ROWTYPE;
  v_deleted_at  timestamptz;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = p_task_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('pruned', false, 'reason', 'not_found');
  END IF;
  IF t.content_purged_at IS NOT NULL THEN
    RETURN jsonb_build_object('pruned', false, 'reason', 'already_purged');
  END IF;
  IF t.status NOT IN ('completed', 'expired') THEN
    RETURN jsonb_build_object('pruned', false, 'reason', 'not_terminal');
  END IF;
  IF now() < t.updated_at + make_interval(secs => p_window_seconds) THEN
    RETURN jsonb_build_object('pruned', false, 'reason', 'window_open');
  END IF;

  v_deleted_at := now();

  -- Overwrite in place. task_description is NOT NULL (001) so it clears to ''.
  -- accepted_description_hash is deliberately NOT cleared — it is a commitment,
  -- the same retention posture as spec_hash. updated_at is deliberately preserved
  -- (019's own line, carried forward): the prune is not a state transition, and
  -- the public feed's timing should reflect settlement, not housekeeping.
  UPDATE tasks SET
    task_description      = '',
    acceptance_spec       = NULL,
    spec_schema_version   = NULL,
    content_purged_at     = v_deleted_at,
    content_purge_rule    = p_rule_version,
    updated_at            = t.updated_at
  WHERE id = p_task_id;

  -- Scratch copies (ADR-0002 D4): the description history is task content and
  -- dies with the task (016's own comment). Evidence URLs and verdict
  -- breakdowns need no equivalent — the platform never stores them (D3: the
  -- checker streams and holds nothing; the verdict service is stateless).

  DELETE FROM task_description_history WHERE task_id = p_task_id;

  INSERT INTO task_content_deletion_log
    (task_id, payment_request_id, retention_rule_version, deleted_at)
  VALUES
    (p_task_id, t.payment_request_id, p_rule_version, v_deleted_at);

  RETURN jsonb_build_object(
    'pruned', true,
    'payment_request_id', t.payment_request_id,
    'deleted_at', v_deleted_at
  );
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION prune_task_content(uuid, text, integer)
  FROM anon, authenticated, public;

-- ── tasks_public: deliberately unchanged ────────────────────────────────────
-- The view's explicit column list is the access control (migration 011). The pin
-- is worker-facing content alongside task_description, which the view already
-- excludes; publishing the hash would not leak the prose (it is a one-way
-- commitment) but there is no public-feed reason for it either. Stated here
-- rather than left implicit, per CLAUDE.md: re-check the list whenever tasks
-- gains a column. No RLS or grant changes needed — service_role bypasses RLS and
-- is the only writer (migration 016 convention).
