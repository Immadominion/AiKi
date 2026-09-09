-- Uncertain transactions never become retryable merely because a process restarts.
CREATE TABLE execution_attempts (
  id UUID PRIMARY KEY,
  authorization_id UUID NOT NULL REFERENCES authorizations(id),
  job_id UUID NOT NULL REFERENCES jobs(id),
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  state TEXT NOT NULL CHECK (state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED', 'LANDED', 'REVERTED', 'REFUSED')),
  transaction_hash TEXT CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_unresolved_execution_per_authorization
  ON execution_attempts(authorization_id)
  WHERE state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED');
