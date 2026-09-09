-- Unknown legacy senders are intentionally NOT inferred from today's key or
-- mandate. Application claims fail closed behind any such pending chain row.
ALTER TABLE execution_attempts ADD COLUMN executor_address TEXT
  CHECK (executor_address ~ '^0x[0-9a-f]{40}$'
    AND executor_address <> '0x0000000000000000000000000000000000000000');

CREATE UNIQUE INDEX one_unresolved_execution_per_signer
  ON execution_attempts (chain_id, executor_address)
  WHERE executor_address IS NOT NULL
    AND state IN ('PREPARING', 'SUBMITTED', 'UNCONFIRMED');
