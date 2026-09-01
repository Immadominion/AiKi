-- What the buyer actually parted with, in base units of the settlement asset.
--
-- The sale already recorded a price and a total, both in points, and points are
-- the wrong unit for a mandate: caps are written in base units of an asset that
-- carries eighteen decimals on BNB Chain, and comparing one against the other
-- is a factor of 10^14. So funding counts base units against the cap, and a
-- refund has to give back exactly that number rather than a figure worked out
-- again from the points, which would round twice and disagree with itself.
--
-- NUMERIC(78,0) for the same reason `authorizations.spent` uses it: a uint256
-- amount does not fit in BIGINT, and a cap that silently overflows is worse
-- than no cap.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sold_outlay NUMERIC(78, 0);

-- Recorded with the rest of the terms or not at all.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_sale_complete;
ALTER TABLE jobs ADD CONSTRAINT jobs_sale_complete CHECK (
  (sold_agent_id IS NULL AND sold_price_points IS NULL AND sold_total_points IS NULL)
  OR (sold_agent_id IS NOT NULL AND sold_price_points IS NOT NULL AND sold_total_points IS NOT NULL)
);
