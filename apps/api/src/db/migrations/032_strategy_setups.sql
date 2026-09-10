-- Wallet setup is not a mandate. No authorization or executable job exists
-- until the exact signed grant and an inert strategy watch are filed atomically.
CREATE TABLE strategy_setups (
  id UUID PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^0x[0-9a-f]{64}$'),
  prepared JSONB NOT NULL,
  gas_limit_wei NUMERIC(78,0) NOT NULL CHECK (gas_limit_wei > 0),
  binding JSONB,
  unsigned_authority JSONB,
  authority_review JSONB,
  compiled_policy JSONB,
  authority_digest TEXT CHECK (authority_digest ~ '^0x[0-9a-f]{64}$'),
  authorization_id UUID UNIQUE REFERENCES authorizations(id),
  job_id UUID UNIQUE REFERENCES jobs(id),
  watch_id UUID UNIQUE REFERENCES strategy_watches(id),
  signed_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner,idempotency_key),
  CHECK ((unsigned_authority IS NULL) = (authority_review IS NULL)),
  CHECK ((unsigned_authority IS NULL) = (compiled_policy IS NULL)),
  CHECK ((unsigned_authority IS NULL) = (authority_digest IS NULL)),
  CHECK ((authorization_id IS NULL) = (job_id IS NULL)),
  CHECK ((authorization_id IS NULL) = (watch_id IS NULL)),
  CHECK ((authorization_id IS NULL) = (signed_at IS NULL)),
  CHECK (authorization_id IS NULL OR (binding IS NOT NULL AND unsigned_authority IS NOT NULL))
);
CREATE INDEX strategy_setups_owner ON strategy_setups(owner,created_at DESC);

-- One funding intent can require reset, exact approval, then fund. Those are
-- separate wallet actions, but retrying its key may not change the owner’s amounts.
CREATE TABLE strategy_setup_intents (
  setup_id UUID NOT NULL REFERENCES strategy_setups(id),
  intent_key TEXT NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^0x[0-9a-f]{64}$'),
  PRIMARY KEY(setup_id,intent_key)
);

CREATE TABLE strategy_setup_actions (
  id UUID PRIMARY KEY,
  setup_id UUID NOT NULL REFERENCES strategy_setups(id),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^0x[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('deploy','approve_reset','approve','fund','approve_nft','enroll','resume','pause','withdraw')),
  transaction_data JSONB NOT NULL,
  review JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','SUBMITTED','FINALIZED','REVERTED','NEEDS_REVIEW')),
  transaction_hash TEXT UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_block NUMERIC(78,0) CHECK (receipt_block >= 0),
  receipt_hash TEXT CHECK (receipt_hash ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (setup_id,request_digest),
  CHECK (state NOT IN ('SUBMITTED','FINALIZED','REVERTED') OR transaction_hash IS NOT NULL),
  CHECK ((receipt_block IS NULL) = (receipt_hash IS NULL))
);
CREATE UNIQUE INDEX one_open_setup_action ON strategy_setup_actions(setup_id)
  WHERE state IN ('PREPARED','SUBMITTED','NEEDS_REVIEW');

CREATE FUNCTION guard_strategy_setup_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner <> NEW.owner OR OLD.idempotency_key <> NEW.idempotency_key OR
     OLD.request_digest <> NEW.request_digest OR OLD.prepared <> NEW.prepared OR
     OLD.gas_limit_wei <> NEW.gas_limit_wei OR
     (OLD.binding IS NOT NULL AND OLD.binding IS DISTINCT FROM NEW.binding) OR
     (OLD.unsigned_authority IS NOT NULL AND (OLD.unsigned_authority IS DISTINCT FROM NEW.unsigned_authority OR
       OLD.authority_review IS DISTINCT FROM NEW.authority_review OR OLD.compiled_policy IS DISTINCT FROM NEW.compiled_policy OR
       OLD.authority_digest IS DISTINCT FROM NEW.authority_digest)) OR
     (OLD.authorization_id IS NOT NULL AND (OLD.authorization_id IS DISTINCT FROM NEW.authorization_id OR
       OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.watch_id IS DISTINCT FROM NEW.watch_id OR OLD.signed_at IS DISTINCT FROM NEW.signed_at))
  THEN RAISE EXCEPTION 'Strategy setup identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_setup_identity BEFORE UPDATE ON strategy_setups
  FOR EACH ROW EXECUTE FUNCTION guard_strategy_setup_identity();

CREATE FUNCTION guard_strategy_setup_action() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.setup_id <> NEW.setup_id OR OLD.request_digest <> NEW.request_digest OR
    OLD.kind <> NEW.kind OR OLD.transaction_data <> NEW.transaction_data OR OLD.review <> NEW.review OR
    (OLD.transaction_hash IS NOT NULL AND OLD.transaction_hash IS DISTINCT FROM NEW.transaction_hash) OR
    (OLD.state IN ('FINALIZED','REVERTED') AND (OLD.state <> NEW.state OR
      OLD.receipt_block IS DISTINCT FROM NEW.receipt_block OR OLD.receipt_hash IS DISTINCT FROM NEW.receipt_hash))
  THEN RAISE EXCEPTION 'Strategy wallet action identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_setup_action_identity BEFORE UPDATE ON strategy_setup_actions
  FOR EACH ROW EXECUTE FUNCTION guard_strategy_setup_action();
