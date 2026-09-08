-- Search reads each agent's LATEST row for two predicates, which is a DISTINCT ON
-- over (predicate, chain_id, registry, agent_id) ordered by observed_at. Without a
-- matching index that is a sort of the whole table on every keystroke.
--
-- Measured on a 56k-row copy of production: 111ms before, 75ms after.
--
-- Deliberately NOT CONCURRENTLY. The migration runner wraps every file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one, so the
-- keyword would turn `db:migrate` into a hard failure and, because migrate is
-- the pre-deploy command, would leave the API permanently unable to boot. The
-- table is small enough that a plain build is sub-second.
CREATE INDEX IF NOT EXISTS observations_latest_by_agent_idx
  ON observations (predicate, chain_id, lower(registry_address), agent_id, observed_at DESC);
