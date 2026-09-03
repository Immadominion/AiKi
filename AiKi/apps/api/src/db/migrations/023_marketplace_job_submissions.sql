CREATE TABLE IF NOT EXISTS job_submissions (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES marketplace_jobs(id) ON DELETE RESTRICT,
  provider_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  output JSONB NOT NULL CHECK (jsonb_typeof(output) = 'object'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  artifact_uri TEXT CHECK (
    artifact_uri IS NULL
    OR artifact_uri ~ '^(https://|ipfs://)[^\s]+$'
  ),
  note TEXT,
  submission_hash TEXT NOT NULL CHECK (submission_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, revision_number),
  UNIQUE (job_id, submission_hash)
);

CREATE INDEX IF NOT EXISTS job_submissions_job_idx
  ON job_submissions (job_id, revision_number DESC);

DROP TRIGGER IF EXISTS job_submissions_immutable ON job_submissions;
CREATE TRIGGER job_submissions_immutable
  BEFORE UPDATE OR DELETE ON job_submissions
  FOR EACH ROW EXECUTE FUNCTION reject_marketplace_immutable_mutation();
