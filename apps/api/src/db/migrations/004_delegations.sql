-- The signed delegation that turns a mandate from a row into authority.
--
-- Until now an authorization recorded what a person chose and nothing carried
-- their signature, so the limits were only ever enforced by AiKi relaying. This
-- holds the delegation the wallet signed, which the deployed manager checks for
-- itself, and which is the whole difference between a limit AiKi counts and one
-- the chain refuses to exceed.
--
-- Stored verbatim as JSONB rather than split into typed columns. The signature
-- covers an exact EIP-712 hash of these fields, and rebuilding the struct from
-- columns risks reordering caveats or reformatting a bytes field, either of
-- which changes the digest and invalidates a signature that was perfectly good.
-- Receipts are stored the same way and for the same reason.
ALTER TABLE authorizations ADD COLUMN IF NOT EXISTS delegation JSONB;

-- The account the value lives in, and the chain its manager is on. Kept beside
-- the delegation rather than read out of it, because these are what a query
-- needs to answer "which mandates could this account still act under", and a
-- JSONB path lookup is the wrong tool for that.
ALTER TABLE authorizations ADD COLUMN IF NOT EXISTS delegator TEXT;
ALTER TABLE authorizations ADD COLUMN IF NOT EXISTS delegation_chain_id INTEGER;
ALTER TABLE authorizations ADD COLUMN IF NOT EXISTS delegation_signed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS authorizations_delegator_idx
  ON authorizations (lower(delegator), delegation_chain_id)
  WHERE delegator IS NOT NULL;
