-- Agreements are created before the funding transaction exists. The external
-- escrow job id is chain evidence, not an input to the immutable marketplace
-- terms, so it cannot be required at agreement creation time.

ALTER TABLE job_agreements
  ALTER COLUMN external_job_id DROP NOT NULL;
