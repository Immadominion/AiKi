-- A deployment is claimed BEFORE any gas is spent. No signed transaction bytes
-- are stored. An uncertain hash remains the sole recovery target after restart.
CREATE TABLE account_deployment_attempts (
  id UUID PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$' AND owner <> '0x0000000000000000000000000000000000000000'),
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  funder TEXT NOT NULL CHECK (funder ~ '^0x[0-9a-f]{40}$' AND funder <> '0x0000000000000000000000000000000000000000'),
  manager TEXT NOT NULL CHECK (manager ~ '^0x[0-9a-f]{40}$' AND manager <> '0x0000000000000000000000000000000000000000'),
  state TEXT NOT NULL CHECK (state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED', 'LANDED', 'REFUSED', 'REVERTED')),
  transaction_hash TEXT CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  expected_address TEXT CHECK (expected_address ~ '^0x[0-9a-f]{40}$' AND expected_address <> '0x0000000000000000000000000000000000000000'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((transaction_hash IS NULL) = (expected_address IS NULL))
);

CREATE UNIQUE INDEX one_pending_account_per_owner ON account_deployment_attempts (owner, chain_id)
  WHERE state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED');
CREATE UNIQUE INDEX one_pending_account_per_funder ON account_deployment_attempts (chain_id, funder)
  WHERE state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED');
