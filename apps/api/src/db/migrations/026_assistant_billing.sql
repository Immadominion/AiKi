CREATE TABLE IF NOT EXISTS assistant_requests (
  id UUID PRIMARY KEY,
  owner TEXT NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'UNCONFIRMED')),
  reserved_points BIGINT NOT NULL CHECK (reserved_points >= 0),
  usage_points BIGINT NOT NULL DEFAULT 0 CHECK (usage_points >= 0),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner, idempotency_key),
  CHECK (state <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS assistant_requests_recent_idx ON assistant_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_requests_unresolved_idx ON assistant_requests (owner) WHERE state <> 'COMPLETED';
