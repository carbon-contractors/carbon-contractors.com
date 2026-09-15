-- 019_task_content_retention.sql
-- CC-087: verifiable task content deletion at terminal state + dispute window.
-- ADR-0002 D4 states the rule (retention tied to the last moment the data can be
-- needed, not a calendar); D9 states the constraint (deletion must be verifiable,
-- and DELETE is not deletion).
--
-- Mechanism note. CC-087's preferred end state is partition-by-settlement-week and
-- DROP PARTITION — zero MVCC residue, one DDL statement. That is a storage-layout
-- change this migration does not make. What ships here is the acknowledged
-- fallback: overwrite the content columns in place (so no live reader and no
-- future row-DELETE ever sees the preimage) and keep the row as its public
-- skeleton. The engine and the deletion log below are mechanism-independent;
-- switching to partition-drop later changes how rows leave, not what must be
-- gone or what the audit record says.

-- ── Purge markers on tasks ──────────────────────────────────────────────────
-- The row itself carries when and under which rule its content was purged, so
-- `verify-retention` (CC-085) can check the invariant from the table alone.
-- Settable once, never clearable — enforced by the trigger below.

ALTER TABLE tasks
  ADD COLUMN content_purged_at timestamptz,
  ADD COLUMN content_purge_rule text;

-- ── The pruned shape ────────────────────────────────────────────────────────
-- 016 required all three spec columns present or absent together, because a
-- preimage without a hash is unverifiable and a hash without a preimage was, at
-- creation time, nonsense. Pruning makes the second half legitimate: the
-- commitment outlives the preimage by design (ADR-0002 D6 — deleting the
-- preimage satisfies erasure while the on-chain commitment stays meaningful).

ALTER TABLE tasks DROP CONSTRAINT tasks_spec_complete;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_spec_complete
  CHECK (
    num_nonnulls(acceptance_spec, spec_hash, spec_schema_version) IN (0, 3)
    OR (
      content_purged_at IS NOT NULL
      AND acceptance_spec IS NULL
      AND spec_schema_version IS NULL
      AND spec_hash IS NOT NULL
    )
  );

-- ── Immutability: permit exactly the one-way prune ──────────────────────────
-- Replaces the function from 018. The spec columns stay immutable from creation
-- with one carve-out: the transition from held to pruned, which may happen once,
-- only on a terminal task, only together with content_purged_at, and only in the
-- direction that clears preimages and preserves commitments. Nothing may ever
-- write content back.

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

-- ── Description history must not capture the prune ──────────────────────────
-- 016's trigger records the SUPERSEDED text on every description change. Applied
-- to the prune UPDATE it would copy the description into task_description_history
-- at the exact moment of deletion — resurrecting what the prune exists to remove,
-- and in a table the prune then has to clean anyway. Skip it for the prune
-- transition only.

CREATE OR REPLACE FUNCTION record_task_description_change() RETURNS trigger AS $$
BEGIN
  IF NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.task_description IS DISTINCT FROM OLD.task_description THEN
    INSERT INTO task_description_history (task_id, task_description)
    VALUES (OLD.id, OLD.task_description);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Auditable deletion records (ADR-0002 D9) ────────────────────────────────
-- An unverifiable deletion claim has the same shape as an unfalsifiable verdict.
-- One row per pruned task: which task, when, under which version of the published
-- retention rule. Carries no content — the columns are identifiers and timing,
-- all of which are already public via tasks_public / the chain.
-- UNIQUE(task_id) encodes "pruned once, ever": the log is append-only in fact,
-- not by convention.

CREATE TABLE task_content_deletion_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  payment_request_id     text NOT NULL,
  retention_rule_version text NOT NULL,
  deleted_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id)
);

CREATE INDEX task_content_deletion_log_payment_request_id_idx
  ON task_content_deletion_log (payment_request_id);

ALTER TABLE task_content_deletion_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_content_deletion_log FROM anon, authenticated;

-- ── The prune RPC ───────────────────────────────────────────────────────────
-- One atomic, SECURITY DEFINER call: eligibility re-check (defence in depth — the
-- TS engine filters first, this holds the line even if called directly), row lock,
-- overwrite, scratch-history delete, deletion-log insert. Returns a verdict the
-- caller can log and audit; never returns or accepts content.
--
-- Eligibility mirrors src/lib/db/retention.ts exactly: terminal status, not
-- already pruned, dispute window elapsed. updated_at is the proxy for "entered
-- terminal state" — every status transition bumps it (009-era convention) and
-- nothing else writes a terminal task.

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
  -- updated_at is deliberately preserved: the prune is not a state transition,
  -- and the public feed's timing should reflect settlement, not housekeeping.
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
-- The view (011) has an explicit column list; content_purged_at and
-- content_purge_rule do not leak into it. Neither is privacy-sensitive, but the
-- list is the access control and CLAUDE.md requires the re-check be stated
-- whenever tasks gains a column. The pruned description ('') IS visible through
-- the feed only via tasks.updated_at timing — the view never exposed
-- task_description in the first place (that is why it exists).
