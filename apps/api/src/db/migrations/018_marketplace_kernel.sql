-- The canonical marketplace kernel. This is additive on purpose: legacy `jobs`
-- are automation runs and legacy `tasks` are the first task-board prototype.
-- Both remain readable while callers move to the versioned marketplace API.

CREATE TABLE IF NOT EXISTS actors (
  id UUID PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'AGENT', 'SYSTEM')),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  controller_address TEXT NOT NULL CHECK (controller_address ~ '^0x[0-9a-f]{40}$'),
  agent_registry_chain_id BIGINT CHECK (agent_registry_chain_id > 0),
  agent_registry_address TEXT CHECK (
    agent_registry_address IS NULL OR agent_registry_address ~ '^0x[0-9a-f]{40}$'
  ),
  agent_token_id NUMERIC(78, 0) CHECK (agent_token_id >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT actors_agent_identity_shape CHECK (
    (actor_type = 'AGENT' AND (
      (agent_registry_chain_id IS NULL AND agent_registry_address IS NULL AND agent_token_id IS NULL)
      OR
      (agent_registry_chain_id IS NOT NULL AND agent_registry_address IS NOT NULL AND agent_token_id IS NOT NULL)
    ))
    OR
    (actor_type <> 'AGENT' AND agent_registry_chain_id IS NULL AND agent_registry_address IS NULL AND agent_token_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS actors_human_wallet_unique
  ON actors (chain_id, controller_address)
  WHERE actor_type = 'HUMAN';
CREATE UNIQUE INDEX IF NOT EXISTS actors_agent_identity_unique
  ON actors (agent_registry_chain_id, agent_registry_address, agent_token_id)
  WHERE agent_registry_chain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS actors_controller_idx
  ON actors (chain_id, controller_address, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_profiles (
  actor_id UUID PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 600),
  availability TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (availability IN ('AVAILABLE', 'BUSY', 'OFFLINE', 'PAUSED')),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 0 AND 10000),
  geography JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(geography) = 'object'),
  supported_protocols TEXT[] NOT NULL DEFAULT '{}',
  verification JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
  reputation JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reputation) = 'object'),
  profile_version BIGINT NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_profiles_available_idx
  ON provider_profiles (updated_at DESC, actor_id)
  WHERE availability = 'AVAILABLE' AND capacity > 0;

CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY,
  provider_actor_id UUID NOT NULL REFERENCES provider_profiles(actor_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE')),
  current_version INTEGER CHECK (current_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offers_published_version CHECK (status = 'DRAFT' OR current_version IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS offers_provider_idx
  ON offers (provider_actor_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS offers_discovery_idx
  ON offers (updated_at DESC, id)
  WHERE status = 'ACTIVE' AND visibility = 'PUBLIC';

CREATE TABLE IF NOT EXISTS offer_versions (
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1200),
  capability_tags TEXT[] NOT NULL DEFAULT '{}',
  input_schema JSONB NOT NULL CHECK (jsonb_typeof(input_schema) = 'object'),
  output_schema JSONB NOT NULL CHECK (jsonb_typeof(output_schema) = 'object'),
  evidence_schema JSONB NOT NULL CHECK (jsonb_typeof(evidence_schema) = 'object'),
  pricing_model TEXT NOT NULL CHECK (pricing_model IN ('FIXED', 'HOURLY', 'MILESTONE', 'QUOTE')),
  settlement_chain_id BIGINT NOT NULL CHECK (settlement_chain_id > 0),
  settlement_token TEXT NOT NULL CHECK (settlement_token ~ '^0x[0-9a-f]{40}$'),
  settlement_decimals SMALLINT NOT NULL CHECK (settlement_decimals BETWEEN 0 AND 255),
  amount NUMERIC(78, 0) CHECK (amount >= 0),
  platform_fee_bps INTEGER NOT NULL CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  delivery_sla_seconds INTEGER NOT NULL CHECK (delivery_sla_seconds BETWEEN 60 AND 31536000),
  review_sla_seconds INTEGER NOT NULL CHECK (review_sla_seconds BETWEEN 60 AND 2592000),
  included_revisions INTEGER NOT NULL DEFAULT 0 CHECK (included_revisions BETWEEN 0 AND 100),
  concurrent_capacity INTEGER NOT NULL DEFAULT 1 CHECK (concurrent_capacity BETWEEN 1 AND 10000),
  dispatch_method TEXT NOT NULL CHECK (dispatch_method IN ('HTTP', 'MCP', 'MANUAL', 'NONE')),
  dispatch_endpoint TEXT,
  failover_safe BOOLEAN NOT NULL DEFAULT false,
  terms_hash TEXT NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, version),
  CONSTRAINT offer_versions_price_shape CHECK (
    (pricing_model = 'QUOTE' AND amount IS NULL)
    OR (pricing_model <> 'QUOTE' AND amount IS NOT NULL AND amount > 0)
  ),
  CONSTRAINT offer_versions_dispatch_shape CHECK (
    (dispatch_method IN ('HTTP', 'MCP') AND dispatch_endpoint IS NOT NULL)
    OR (dispatch_method IN ('MANUAL', 'NONE') AND dispatch_endpoint IS NULL)
  )
);

ALTER TABLE offers
  ADD CONSTRAINT offers_current_version_fk
  FOREIGN KEY (id, current_version)
  REFERENCES offer_versions (offer_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS offer_versions_price_idx
  ON offer_versions (settlement_chain_id, settlement_token, amount)
  WHERE amount IS NOT NULL;
CREATE INDEX IF NOT EXISTS offer_versions_capabilities_idx
  ON offer_versions USING GIN (capability_tags);

CREATE TABLE IF NOT EXISTS marketplace_jobs (
  id UUID PRIMARY KEY,
  payer_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  requester_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  provider_actor_id UUID REFERENCES actors(id) ON DELETE RESTRICT,
  procurement_mode TEXT NOT NULL CHECK (procurement_mode IN ('OPEN', 'DIRECT')),
  engagement_type TEXT NOT NULL DEFAULT 'ONE_OFF'
    CHECK (engagement_type IN ('ONE_OFF', 'AUTOMATION')),
  offer_id UUID,
  offer_version INTEGER,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  brief TEXT NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 10000),
  requirements JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requirements) = 'object'),
  definition_of_done TEXT NOT NULL CHECK (char_length(definition_of_done) BETWEEN 1 AND 10000),
  evidence_requirements JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence_requirements) = 'object'),
  work_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (work_state IN (
    'DRAFT', 'OPEN', 'OFFERED', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED',
    'CHANGES_REQUESTED', 'ACCEPTED', 'CANCELLED', 'EXPIRED'
  )),
  settlement_state TEXT NOT NULL DEFAULT 'UNFUNDED' CHECK (settlement_state IN (
    'UNFUNDED', 'FUNDING_SUBMITTED', 'FUNDED', 'RELEASE_SUBMITTED',
    'RELEASED', 'REFUND_SUBMITTED', 'REFUNDED'
  )),
  dispute_state TEXT NOT NULL DEFAULT 'NONE'
    CHECK (dispute_state IN ('NONE', 'OPENED', 'EVIDENCE', 'RESOLVED', 'APPEALED', 'FINAL')),
  payout_state TEXT NOT NULL DEFAULT 'NONE'
    CHECK (payout_state IN ('NONE', 'HOLD', 'AVAILABLE', 'PAID', 'FAILED')),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_jobs_offer_shape CHECK (
    (offer_id IS NULL AND offer_version IS NULL)
    OR (offer_id IS NOT NULL AND offer_version IS NOT NULL)
  ),
  CONSTRAINT marketplace_jobs_direct_provider CHECK (
    procurement_mode <> 'DIRECT' OR provider_actor_id IS NOT NULL
  ),
  CONSTRAINT marketplace_jobs_assigned_provider CHECK (
    work_state NOT IN ('ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'CHANGES_REQUESTED', 'ACCEPTED')
    OR provider_actor_id IS NOT NULL
  ),
  CONSTRAINT marketplace_jobs_no_self_hire CHECK (
    provider_actor_id IS NULL OR payer_actor_id <> provider_actor_id
  ),
  FOREIGN KEY (offer_id, offer_version)
    REFERENCES offer_versions (offer_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS marketplace_jobs_payer_idx
  ON marketplace_jobs (payer_actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_jobs_requester_idx
  ON marketplace_jobs (requester_actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_jobs_provider_idx
  ON marketplace_jobs (provider_actor_id, created_at DESC)
  WHERE provider_actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketplace_jobs_open_idx
  ON marketplace_jobs (created_at DESC, id)
  WHERE work_state = 'OPEN' AND settlement_state = 'FUNDED';

CREATE TABLE IF NOT EXISTS job_agreements (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES marketplace_jobs(id) ON DELETE RESTRICT,
  payer_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  requester_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  provider_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  evaluator_actor_id UUID REFERENCES actors(id) ON DELETE RESTRICT,
  payee_address TEXT NOT NULL CHECK (payee_address ~ '^0x[0-9a-f]{40}$'),
  offer_id UUID,
  offer_version INTEGER,
  requirements JSONB NOT NULL CHECK (jsonb_typeof(requirements) = 'object'),
  evidence_requirements JSONB NOT NULL CHECK (jsonb_typeof(evidence_requirements) = 'object'),
  gross_amount NUMERIC(78, 0) NOT NULL CHECK (gross_amount > 0),
  provider_amount NUMERIC(78, 0) NOT NULL CHECK (provider_amount >= 0),
  platform_fee_amount NUMERIC(78, 0) NOT NULL CHECK (platform_fee_amount >= 0),
  settlement_chain_id BIGINT NOT NULL CHECK (settlement_chain_id > 0),
  settlement_token TEXT NOT NULL CHECK (settlement_token ~ '^0x[0-9a-f]{40}$'),
  settlement_decimals SMALLINT NOT NULL CHECK (settlement_decimals BETWEEN 0 AND 255),
  delivery_deadline TIMESTAMPTZ NOT NULL,
  review_deadline TIMESTAMPTZ NOT NULL,
  dispute_deadline TIMESTAMPTZ NOT NULL,
  hard_expiry TIMESTAMPTZ NOT NULL,
  revision_allowance INTEGER NOT NULL DEFAULT 0 CHECK (revision_allowance BETWEEN 0 AND 100),
  authorization_id UUID REFERENCES authorizations(id) ON DELETE RESTRICT,
  settlement_rail TEXT NOT NULL,
  settlement_rail_version TEXT NOT NULL,
  settlement_contract TEXT NOT NULL CHECK (settlement_contract ~ '^0x[0-9a-f]{40}$'),
  external_job_id NUMERIC(78, 0) NOT NULL CHECK (external_job_id >= 0),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  terms_hash TEXT NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_agreements_value_conserved CHECK (
    provider_amount + platform_fee_amount = gross_amount
  ),
  CONSTRAINT job_agreements_deadlines_ordered CHECK (
    delivery_deadline < review_deadline
    AND review_deadline <= dispute_deadline
    AND dispute_deadline < hard_expiry
  ),
  CONSTRAINT job_agreements_offer_shape CHECK (
    (offer_id IS NULL AND offer_version IS NULL)
    OR (offer_id IS NOT NULL AND offer_version IS NOT NULL)
  ),
  FOREIGN KEY (offer_id, offer_version)
    REFERENCES offer_versions (offer_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS job_agreements_provider_idx
  ON job_agreements (provider_actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_agreements_expiry_idx
  ON job_agreements (hard_expiry, job_id);

CREATE TABLE IF NOT EXISTS marketplace_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id UUID NOT NULL UNIQUE,
  job_id UUID NOT NULL REFERENCES marketplace_jobs(id) ON DELETE RESTRICT,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
  actor_id UUID REFERENCES actors(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  request_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, aggregate_version)
);

CREATE INDEX IF NOT EXISTS marketplace_events_job_idx
  ON marketplace_events (job_id, sequence);
CREATE INDEX IF NOT EXISTS marketplace_events_correlation_idx
  ON marketplace_events (correlation_id, sequence);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_body JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_id, operation, idempotency_key),
  CONSTRAINT idempotency_records_result_shape CHECK (
    (status = 'COMPLETED' AND response_status IS NOT NULL AND response_body IS NOT NULL)
    OR (status = 'FAILED' AND error_code IS NOT NULL)
    OR status = 'IN_PROGRESS'
  ),
  CONSTRAINT idempotency_records_expiry_order CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx
  ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
  topic TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_lock_shape CHECK (
    (locked_at IS NULL AND locked_by IS NULL) OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events (available_at, created_at, id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS outbox_events_stuck_idx
  ON outbox_events (locked_at, id)
  WHERE status = 'PROCESSING';

CREATE TABLE IF NOT EXISTS settlement_operations (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES marketplace_jobs(id) ON DELETE RESTRICT,
  agreement_id UUID NOT NULL REFERENCES job_agreements(id) ON DELETE RESTRICT,
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('FUND', 'RELEASE', 'REFUND', 'RESOLVE_DISPUTE')),
  logical_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'REQUESTED', 'SUBMITTED', 'MINED', 'FINALIZED', 'REPLACED', 'REVERTED', 'ABANDONED'
  )),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  amount NUMERIC(78, 0) NOT NULL CHECK (amount >= 0),
  transaction_hash TEXT CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_nonce NUMERIC(78, 0) CHECK (transaction_nonce >= 0),
  replacement_for UUID REFERENCES settlement_operations(id) ON DELETE RESTRICT,
  failure_code TEXT,
  failure_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  CONSTRAINT settlement_operations_finality_shape CHECK (
    status <> 'FINALIZED' OR (transaction_hash IS NOT NULL AND finalized_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS settlement_operations_job_idx
  ON settlement_operations (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS settlement_operations_pending_idx
  ON settlement_operations (created_at, id)
  WHERE status IN ('REQUESTED', 'SUBMITTED', 'MINED');

CREATE TABLE IF NOT EXISTS chain_events (
  id UUID PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number NUMERIC(78, 0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  event_name TEXT NOT NULL,
  decoded_payload JSONB NOT NULL CHECK (jsonb_typeof(decoded_payload) = 'object'),
  finality TEXT NOT NULL DEFAULT 'OBSERVED'
    CHECK (finality IN ('OBSERVED', 'FINALIZED', 'ORPHANED')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  orphaned_at TIMESTAMPTZ,
  UNIQUE (chain_id, contract_address, transaction_hash, log_index),
  CONSTRAINT chain_events_finality_shape CHECK (
    (finality = 'OBSERVED' AND finalized_at IS NULL AND orphaned_at IS NULL)
    OR (finality = 'FINALIZED' AND finalized_at IS NOT NULL AND orphaned_at IS NULL)
    OR (finality = 'ORPHANED' AND orphaned_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS chain_events_block_idx
  ON chain_events (chain_id, contract_address, block_number, log_index);
CREATE INDEX IF NOT EXISTS chain_events_observed_idx
  ON chain_events (chain_id, block_number, log_index)
  WHERE finality = 'OBSERVED';

CREATE TABLE IF NOT EXISTS source_links (
  source_type TEXT NOT NULL CHECK (source_type IN ('LEGACY_JOB', 'TASK', 'WATCH')),
  source_id TEXT NOT NULL,
  marketplace_job_id UUID NOT NULL REFERENCES marketplace_jobs(id) ON DELETE RESTRICT,
  migration_version INTEGER NOT NULL CHECK (migration_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id),
  UNIQUE (marketplace_job_id, source_type)
);

CREATE OR REPLACE FUNCTION reject_marketplace_immutable_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS offer_versions_immutable ON offer_versions;
CREATE TRIGGER offer_versions_immutable
  BEFORE UPDATE OR DELETE ON offer_versions
  FOR EACH ROW EXECUTE FUNCTION reject_marketplace_immutable_mutation();

DROP TRIGGER IF EXISTS job_agreements_immutable ON job_agreements;
CREATE TRIGGER job_agreements_immutable
  BEFORE UPDATE OR DELETE ON job_agreements
  FOR EACH ROW EXECUTE FUNCTION reject_marketplace_immutable_mutation();

DROP TRIGGER IF EXISTS marketplace_events_immutable ON marketplace_events;
CREATE TRIGGER marketplace_events_immutable
  BEFORE UPDATE OR DELETE ON marketplace_events
  FOR EACH ROW EXECUTE FUNCTION reject_marketplace_immutable_mutation();
