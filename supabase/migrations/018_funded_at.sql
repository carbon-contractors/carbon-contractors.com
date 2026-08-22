-- 018_funded_at.sql
-- CC-092: capture the funding block timestamp once, at the moment /api/fund-task
-- already reads the chain to confirm Funded — rather than scanning TaskCreated
-- events later. Needed by the eventual verdict service's TaskContext, for
-- ADR-0001 D3's captured_after: "task_funding_block_timestamp" criterion.

ALTER TABLE tasks
  ADD COLUMN funded_at timestamptz;

-- Settable once (NULL -> a value), then immutable — same reasoning as the spec
-- columns (016): a value the checker treats as an anti-fraud threshold must not
-- be movable after the fact. Unlike the spec columns this is not present from
-- creation, so it cannot use the "immutable unconditionally" rule verbatim.
CREATE OR REPLACE FUNCTION prevent_task_mutation() RETURNS trigger AS $$
BEGIN
  -- Spec commitment: immutable from creation.
  IF NEW.acceptance_spec     IS DISTINCT FROM OLD.acceptance_spec
  OR NEW.spec_hash           IS DISTINCT FROM OLD.spec_hash
  OR NEW.spec_schema_version IS DISTINCT FROM OLD.spec_schema_version
  THEN
    RAISE EXCEPTION 'Cannot modify the acceptance spec once a task row exists (CC-084)';
  END IF;

  -- funded_at: settable once, then locked.
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

-- tasks_public (011) is deliberately unchanged — funded_at is not privacy-sensitive
-- (it is timing already visible on-chain), but the view's column list is the access
-- control and CLAUDE.md requires this line whether or not a new column is added to it.
