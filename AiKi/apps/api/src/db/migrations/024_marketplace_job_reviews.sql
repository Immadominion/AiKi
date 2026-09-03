CREATE TABLE IF NOT EXISTS job_reviews (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES marketplace_jobs(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL REFERENCES job_submissions(id) ON DELETE RESTRICT,
  reviewer_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT', 'REQUEST_CHANGES')),
  note TEXT,
  required_changes JSONB CHECK (
    required_changes IS NULL
    OR jsonb_typeof(required_changes) = 'object'
  ),
  review_hash TEXT NOT NULL CHECK (review_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id),
  UNIQUE (job_id, review_hash)
);

CREATE INDEX IF NOT EXISTS job_reviews_job_idx
  ON job_reviews (job_id, created_at DESC);

DROP TRIGGER IF EXISTS job_reviews_immutable ON job_reviews;
CREATE TRIGGER job_reviews_immutable
  BEFORE UPDATE OR DELETE ON job_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_marketplace_immutable_mutation();
