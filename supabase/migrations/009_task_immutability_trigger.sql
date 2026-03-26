-- 009_task_immutability_trigger.sql
-- AUD-002: Prevent mutation of critical fields on funded/active tasks.
-- Once a task leaves 'pending' status, to_human_wallet, from_agent_wallet,
-- amount_usdc, deadline_unix, and payment_request_id are immutable.
-- This applies even to service_role queries.

CREATE OR REPLACE FUNCTION prevent_task_mutation() RETURNS trigger AS $$
BEGIN
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

ALTER FUNCTION public.prevent_task_mutation() SET search_path = public;

CREATE TRIGGER trg_prevent_task_mutation
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION prevent_task_mutation();
