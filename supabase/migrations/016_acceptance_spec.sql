-- 016_acceptance_spec.sql
-- CC-084: machine-checkable acceptance criteria, committed as specHash at createTask.
-- ADR-0001 D3/D4, and Amendment 2 A2.1 (prose is mutable but recorded) / A2.2
-- (schema_version lives inside the preimage; no in-flight migration, ever).

-- ── Spec columns ────────────────────────────────────────────────────────────
-- acceptance_spec is the VERBATIM string the agent sent. It is the hash preimage
-- and must never be reserialised — see src/lib/spec/hash.ts for why there is no
-- canonicalisation step.

ALTER TABLE tasks
  ADD COLUMN acceptance_spec     text,
  ADD COLUMN spec_hash           text,
  ADD COLUMN spec_schema_version integer;

-- Lowercase hex, matching the wallet-casing precedent from 014. A mixed-case hash
-- would compare unequal against the on-chain value without erroring.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_spec_hash_format
  CHECK (spec_hash IS NULL OR spec_hash ~ '^0x[0-9a-f]{64}$');

-- All three or none. A spec with no hash cannot be committed on-chain; a hash with
-- no preimage cannot be verified by the worker or re-run by anyone.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_spec_complete
  CHECK (num_nonnulls(acceptance_spec, spec_hash, spec_schema_version) IN (0, 3));

-- ── Immutability ────────────────────────────────────────────────────────────
-- Replaces the function from 009, which named five columns explicitly. New columns
-- do not inherit its protection, so a spec would have been freely mutable on a
-- funded task — destroying the one property specHash exists to provide.
--
-- The three spec columns are immutable UNCONDITIONALLY, not just once past 'pending'.
-- The agent receives the hash from request_human_work while the row is still pending
-- and passes it to createTask; a change in that window would strand them against a
-- stale hash with no error anywhere.

CREATE OR REPLACE FUNCTION prevent_task_mutation() RETURNS trigger AS $$
BEGIN
  -- Spec commitment: immutable from creation.
  IF NEW.acceptance_spec     IS DISTINCT FROM OLD.acceptance_spec
  OR NEW.spec_hash           IS DISTINCT FROM OLD.spec_hash
  OR NEW.spec_schema_version IS DISTINCT FROM OLD.spec_schema_version
  THEN
    RAISE EXCEPTION 'Cannot modify the acceptance spec once a task row exists (CC-084)';
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

-- ── Prose edit history (ADR-0001 Amendment 2 A2.1) ──────────────────────────
-- specHash binds the criteria, not the prose. The prose stays editable so an agent
-- can clarify mid-task — a gate code, a site contact — without that being a new task.
-- Payment cannot follow the prose (the checker reads only the criteria), so this is
-- not a fund-safety control. It closes scope creep: a worker who re-reads the brief
-- mid-job must be able to see that it changed since they accepted.
--
-- ON DELETE CASCADE is load-bearing. ADR-0002 D4 and CC-087 delete task rows at
-- terminal state, and A2.1 is explicit that this history is TASK CONTENT that dies
-- with them — not an audit log to be exempted from retention.

CREATE TABLE task_description_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_description text NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_description_history_task_id_idx
  ON task_description_history (task_id, recorded_at);

-- Records the SUPERSEDED text, so the row set is the history of what the description
-- used to be; the current value is always on tasks itself.
CREATE OR REPLACE FUNCTION record_task_description_change() RETURNS trigger AS $$
BEGIN
  IF NEW.task_description IS DISTINCT FROM OLD.task_description THEN
    INSERT INTO task_description_history (task_id, task_description)
    VALUES (OLD.id, OLD.task_description);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_record_task_description_change
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION record_task_description_change();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- A new table inherits Supabase's default GRANT ALL to anon/authenticated. Revoking
-- in the same migration is the convention (CC-062); service_role bypasses RLS and is
-- the only writer.

ALTER TABLE task_description_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_description_history FROM anon, authenticated;

-- ── tasks_public: deliberately unchanged ────────────────────────────────────
-- The view (011) has an explicit column list, so the three new columns do not leak
-- into it. Stated here rather than left implicit because CLAUDE.md requires the list
-- be re-checked whenever tasks gains a column. The spec must NOT become world-
-- readable: it carries GPS coordinates, site references and an evidence bucket
-- target (ADR-0002 D3).
