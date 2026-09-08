-- Agreement terms stay immutable. The external escrow job id is finalized chain
-- evidence that is unknowable at agreement creation, so allow exactly one fill
-- from NULL to a concrete id and continue rejecting every other mutation.

CREATE OR REPLACE FUNCTION guard_job_agreements_finalization()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;

  IF OLD.external_job_id IS NULL
     AND NEW.external_job_id IS NOT NULL
     AND (to_jsonb(NEW) - 'external_job_id') = (to_jsonb(OLD) - 'external_job_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only except external_job_id finalization', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS job_agreements_immutable ON job_agreements;
CREATE TRIGGER job_agreements_immutable
  BEFORE UPDATE OR DELETE ON job_agreements
  FOR EACH ROW EXECUTE FUNCTION guard_job_agreements_finalization();
