-- Authorizations, jobs, and receipts. Until now these lived in process memory,
-- so every restart orphaned every mandate and every signed receipt.
CREATE TABLE IF NOT EXISTS authorizations (
  id UUID PRIMARY KEY,
  policy_hash TEXT NOT NULL,
  policy JSONB NOT NULL,
  weakest_tier TEXT NOT NULL CHECK (weakest_tier IN ('T0', 'T1', 'T2', 'T3')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  -- Token amounts are uint256 wei and do not fit in BIGINT. NUMERIC(78,0) holds
  -- the full range; storing this as BIGINT silently overflows real balances.
  spent NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (spent >= 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS authorizations_status_idx ON authorizations (status, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  authorization_id UUID NOT NULL REFERENCES authorizations(id),
  status TEXT NOT NULL CHECK (
    status IN ('AUTHORIZED', 'DISPATCHED', 'RUNNING', 'COMPLETED', 'REJECTED', 'CANCELLED')
  ),
  -- Retrying a create with the same key must return the first job, never a second.
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_authorization_idx ON jobs (authorization_id, created_at DESC);

-- Append-only, and ordered by identity rather than timestamp so two events in the
-- same millisecond still have a defined order for streaming and replay.
CREATE TABLE IF NOT EXISTS job_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('status', 'policy', 'spend')),
  detail TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, seq);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id UUID NOT NULL,
  mandate_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  -- The signature covers the exact JSON body. Rebuilding it from typed columns
  -- would reformat timestamps and break verification, so the signed bytes are
  -- stored verbatim and returned unchanged; the columns above are for queries.
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipts_job_idx ON receipts (job_id, created_at DESC);
