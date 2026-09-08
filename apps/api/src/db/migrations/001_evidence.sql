-- Immutable facts only. Corrections supersede observations; projections are rebuildable.
CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY,
  subject_type TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  registry_address TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value JSONB NOT NULL,
  valid_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence_class CHAR(1) NOT NULL CHECK (evidence_class IN ('A', 'B', 'C', 'D')),
  block_number BIGINT,
  log_index INTEGER,
  transaction_hash TEXT,
  finality TEXT CHECK (finality IN ('provisional', 'safe', 'finalized')),
  supersedes UUID REFERENCES observations(id),
  superseded_reason TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  CHECK (recorded_at >= observed_at)
);
CREATE INDEX IF NOT EXISTS observations_agent_time_idx ON observations (chain_id, registry_address, agent_id, valid_at DESC);
CREATE INDEX IF NOT EXISTS observations_predicate_time_idx ON observations (predicate, observed_at DESC);
CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  stream TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL CHECK (last_indexed_block >= 0),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE OR REPLACE FUNCTION reject_observation_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'observations are append-only; insert a superseding fact instead'; END;
$$;
DROP TRIGGER IF EXISTS observations_no_update ON observations;
CREATE TRIGGER observations_no_update BEFORE UPDATE OR DELETE ON observations FOR EACH ROW EXECUTE FUNCTION reject_observation_mutation();
