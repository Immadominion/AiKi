-- A successful generic transaction is not a verified strategy transition.
ALTER TABLE execution_attempts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'legacy'
  CHECK (purpose IN ('legacy', 'strategy'));

CREATE TABLE strategy_watches (
  id UUID PRIMARY KEY,
  authorization_id UUID NOT NULL UNIQUE REFERENCES authorizations(id),
  job_id UUID NOT NULL UNIQUE REFERENCES jobs(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 56),
  vault TEXT NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  controller TEXT NOT NULL CHECK (controller ~ '^0x[0-9a-f]{40}$'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  runtime_code_hash TEXT NOT NULL CHECK (runtime_code_hash ~ '^0x[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('yield', 'grid', 'lp')),
  manager TEXT NOT NULL CHECK (manager ~ '^0x[0-9a-f]{40}$'),
  executor TEXT NOT NULL CHECK (executor ~ '^0x[0-9a-f]{40}$'),
  binding_enforcer TEXT NOT NULL CHECK (binding_enforcer ~ '^0x[0-9a-f]{40}$'),
  status TEXT NOT NULL DEFAULT 'PAUSED' CHECK (status IN ('PAUSED', 'ACTIVE', 'NEEDS_REVIEW', 'CLOSED')),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  checkpoint_nonce NUMERIC(78,0) NOT NULL CHECK (checkpoint_nonce >= 0),
  checkpoint JSONB NOT NULL,
  chain_snapshot JSONB,
  snapshot_block NUMERIC(78,0) CHECK (snapshot_block >= 0),
  snapshot_hash TEXT CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  snapshot_timestamp TIMESTAMPTZ,
  policy JSONB NOT NULL,
  gas_limit_wei NUMERIC(78,0) NOT NULL CHECK (gas_limit_wei > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, vault),
  CHECK ((snapshot_block IS NULL) = (snapshot_hash IS NULL))
);

CREATE TABLE strategy_operations (
  attempt_id UUID PRIMARY KEY REFERENCES execution_attempts(id),
  watch_id UUID NOT NULL REFERENCES strategy_watches(id),
  watch_revision BIGINT NOT NULL CHECK (watch_revision >= 0),
  expected_nonce NUMERIC(78,0) NOT NULL CHECK (expected_nonce >= 0),
  operation_digest TEXT NOT NULL CHECK (operation_digest ~ '^0x[0-9a-f]{64}$'),
  call_data_hash TEXT NOT NULL CHECK (call_data_hash ~ '^0x[0-9a-f]{64}$'),
  envelope_hash TEXT NOT NULL CHECK (envelope_hash ~ '^0x[0-9a-f]{64}$'),
  gas_limit_wei NUMERIC(78,0) NOT NULL CHECK (gas_limit_wei > 0),
  operation JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'LANDED', 'REVERTED', 'REFUSED')),
  verified_receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK ((state = 'PENDING') = (completed_at IS NULL)),
  CHECK ((state IN ('LANDED', 'REVERTED')) = (verified_receipt IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_strategy_operation ON strategy_operations(watch_id)
  WHERE state = 'PENDING';

-- Even older generic recovery/finish code cannot silently unlock a strategy.
-- The specialized store writes the verified operation, checkpoint and attempt
-- together. This deferred check also detects a partial write at transaction end.
CREATE FUNCTION enforce_strategy_execution_transition() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  operation_state TEXT;
  operation_job UUID;
  operation_authorization UUID;
  operation_chain INTEGER;
  operation_executor TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.purpose <> NEW.purpose THEN
    RAISE EXCEPTION 'An execution purpose cannot be changed';
  END IF;
  IF NEW.purpose <> 'strategy' THEN
    IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM strategy_watches WHERE authorization_id = NEW.authorization_id) THEN
      RAISE EXCEPTION 'Registered strategy mandates cannot use legacy execution';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.authorization_id <> NEW.authorization_id OR OLD.job_id <> NEW.job_id OR
    OLD.chain_id <> NEW.chain_id OR OLD.executor_address IS DISTINCT FROM NEW.executor_address OR
    (OLD.transaction_hash IS NOT NULL AND OLD.transaction_hash IS DISTINCT FROM NEW.transaction_hash) OR
    (OLD.state IN ('LANDED','REVERTED','REFUSED') AND OLD.state <> NEW.state)
  ) THEN RAISE EXCEPTION 'Strategy execution identity is immutable'; END IF;
  SELECT o.state, w.job_id, w.authorization_id, w.chain_id, w.executor
    INTO operation_state, operation_job, operation_authorization, operation_chain, operation_executor
    FROM strategy_operations o JOIN strategy_watches w ON w.id = o.watch_id
    WHERE o.attempt_id = NEW.id;
  IF operation_state IS NULL OR operation_job <> NEW.job_id OR
    operation_authorization <> NEW.authorization_id OR operation_chain <> NEW.chain_id OR
    operation_executor IS DISTINCT FROM NEW.executor_address THEN
    RAISE EXCEPTION 'Strategy execution must have its matching durable operation';
  END IF;
  IF (NEW.state IN ('LANDED','REVERTED','REFUSED') AND operation_state <> NEW.state) OR
    (NEW.state IN ('PREPARING','SUBMITTED','UNCONFIRMED') AND operation_state <> 'PENDING') THEN
    RAISE EXCEPTION 'Strategy execution needs atomic verified outcome settlement';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER strategy_execution_transition
  AFTER INSERT OR UPDATE ON execution_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_strategy_execution_transition();

CREATE FUNCTION enforce_strategy_operation_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  attempt_purpose TEXT;
  attempt_state TEXT;
BEGIN
  SELECT purpose, state INTO attempt_purpose, attempt_state FROM execution_attempts WHERE id = NEW.attempt_id;
  IF attempt_purpose IS DISTINCT FROM 'strategy' OR
    (NEW.state = 'PENDING' AND attempt_state NOT IN ('PREPARING','SUBMITTED','UNCONFIRMED')) OR
    (NEW.state <> 'PENDING' AND attempt_state <> NEW.state) THEN
    RAISE EXCEPTION 'Strategy operation needs its matching atomic execution state';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.attempt_id <> NEW.attempt_id OR OLD.watch_id <> NEW.watch_id OR OLD.expected_nonce <> NEW.expected_nonce OR
    OLD.watch_revision <> NEW.watch_revision OR OLD.operation_digest <> NEW.operation_digest OR
    OLD.call_data_hash <> NEW.call_data_hash OR OLD.envelope_hash <> NEW.envelope_hash OR OLD.gas_limit_wei <> NEW.gas_limit_wei OR OLD.operation <> NEW.operation OR
    (OLD.state <> 'PENDING' AND OLD IS DISTINCT FROM NEW)
  ) THEN RAISE EXCEPTION 'Prepared strategy operation and terminal evidence are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER strategy_operation_pair
  AFTER INSERT OR UPDATE ON strategy_operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_strategy_operation_pair();
