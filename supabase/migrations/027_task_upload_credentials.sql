-- 027_task_upload_credentials.sql
--
-- ADR-0010 (accepted 2026-09-28) — evidence upload via pre-signed writes into
-- the hiring agent's own bucket. NOR-334, CC-101.
--
-- WHY THIS EXISTS
--
-- A worker on a phone cannot host files. The platform will not host them
-- either (ADR-0010 D1: it never holds evidence bytes — ADR-0002 D2.2's public
-- claim stays true). So the agent hands over a write-only credential for its
-- own bucket at request_human_work time, and the platform mints short-lived
-- pre-signed PUTs from it for the assigned worker. This table holds that
-- credential, and nothing else, for as long as a grant could still be needed.
--
-- SHAPE
--
-- `credential_envelope` is ciphertext: AES-256-GCM under a per-row data key,
-- the data key wrapped by the dedicated `evidence-credentials` KMS key, the
-- task's payment_request_id bound as AAD at both layers
-- (src/lib/evidence/credential-crypto.ts). The bucket's name and provider are
-- NOT here — they are in the task's acceptance spec (evidence_bucket), which
-- the agent committed to on-chain via specHash.
--
-- LIFETIME (ADR-0010 D3)
--
-- The grant dies with the task: the trigger below deletes the row the moment
-- the task reaches a state from which no upload can follow (completed,
-- expired, declined, lapsed, disputed), and writes one deletion-log row. The
-- upload route additionally refuses any task not `active` in the DB and
-- `Funded` on-chain, so a row that outlives submitWork grants nothing.
--
-- DELETE is not deletion (ADR-0002 D9): MVCC and PITR keep old tuples for a
-- while. That residue is ciphertext under a production-only KMS key; the
-- key's version destruction is the backstop that renders it inert. Stated,
-- not hidden.
--
-- ACCESS
--
-- Service role only. RLS on, and the default GRANT ALL revoked in this same
-- migration (CLAUDE.md: a new table inherits it otherwise; CC-062).

CREATE TABLE public.task_upload_credentials (
  payment_request_id text PRIMARY KEY
    REFERENCES public.tasks (payment_request_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('s3', 'gcs')),
  credential_envelope text NOT NULL,
  -- ADR-0010 D5: the agent's per-artefact cap, at or below the platform's 25 MB.
  max_upload_bytes integer NOT NULL
    CHECK (max_upload_bytes > 0 AND max_upload_bytes <= 26214400),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.task_upload_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_upload_credentials FROM anon, authenticated;

-- Identifiers and timing only — the same posture as task_content_deletion_log
-- (migration 020). One row per credential ever deleted.
CREATE TABLE public.task_upload_credential_deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id text NOT NULL UNIQUE,
  reason text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.task_upload_credential_deletion_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_upload_credential_deletion_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.drop_upload_credential_on_terminal()
RETURNS trigger
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  IF NEW.status IN ('completed', 'expired', 'declined', 'lapsed', 'disputed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    DELETE FROM task_upload_credentials
      WHERE payment_request_id = NEW.payment_request_id;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed > 0 THEN
      INSERT INTO task_upload_credential_deletion_log (payment_request_id, reason)
        VALUES (NEW.payment_request_id, 'task_' || NEW.status)
        ON CONFLICT (payment_request_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.drop_upload_credential_on_terminal() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER tasks_drop_upload_credential
  AFTER UPDATE OF status ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.drop_upload_credential_on_terminal();

-- Verify after applying (expect: no anon/authenticated rows; RLS true on both):
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public'
--    AND table_name IN ('task_upload_credentials', 'task_upload_credential_deletion_log')
--    AND grantee IN ('anon', 'authenticated');
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('task_upload_credentials', 'task_upload_credential_deletion_log');
