-- Sessions are signed tokens, so only the one-time nonces need storing.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_nonces_expiry_idx ON auth_nonces (expires_at);

-- Who a mandate belongs to. Nullable because rows written before authentication
-- existed have no owner; the API refuses to serve those to anyone rather than
-- guessing, and every row written from here on has one.
ALTER TABLE authorizations ADD COLUMN IF NOT EXISTS owner TEXT;
CREATE INDEX IF NOT EXISTS authorizations_owner_idx ON authorizations (owner, created_at DESC);
