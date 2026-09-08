-- What was actually sold, recorded when the buyer pays.
--
-- The jobs table held no agent and no amount, so settlement had to be told
-- which agent to pay in the request body and had to work out the price again
-- from whatever the registry said by then. Two money-losing consequences, both
-- verified: a buyer could settle naming a different agent and have the money
-- paid to an address they control instead of the seller's, and an agent that
-- changed its published price between funding and settlement was paid a
-- different amount from the one the buyer was charged.
--
-- A sale has terms, and the terms are fixed when the money is taken.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sold_agent_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sold_price_points BIGINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sold_total_points BIGINT;

-- Recorded together or not at all: a price with no agent is not a sale.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_sale_complete;
ALTER TABLE jobs ADD CONSTRAINT jobs_sale_complete CHECK (
  (sold_agent_id IS NULL AND sold_price_points IS NULL AND sold_total_points IS NULL)
  OR (sold_agent_id IS NOT NULL AND sold_price_points IS NOT NULL AND sold_total_points IS NOT NULL)
);
