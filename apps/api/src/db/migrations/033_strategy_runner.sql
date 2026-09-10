ALTER TABLE strategy_watches
  ADD COLUMN planner_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_run_at TIMESTAMPTZ,
  ADD COLUMN last_run_code TEXT,
  ADD COLUMN last_run_reason TEXT,
  ADD COLUMN runner_lease_id UUID,
  ADD COLUMN runner_lease_until TIMESTAMPTZ;
ALTER TABLE strategy_watches ADD CONSTRAINT strategy_lease_pair
  CHECK ((runner_lease_id IS NULL) = (runner_lease_until IS NULL));
CREATE INDEX due_active_strategies ON strategy_watches (next_run_at, id) WHERE status = 'ACTIVE';

CREATE TABLE strategy_runner_heartbeat (
  chain_id INTEGER PRIMARY KEY CHECK (chain_id = 56),
  instance_id UUID NOT NULL,
  configuration_hash TEXT NOT NULL CHECK (configuration_hash ~ '^0x[0-9a-f]{64}$'),
  ready BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) <= 240),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
