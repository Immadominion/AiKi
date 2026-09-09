-- Run on an approved read-only connection and retain the output privately.
-- No replies, idempotency keys, credentials, or configuration secrets are selected.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Paid liabilities remain their original whole points, never recomputed from
-- historical base units using the proposed new rail's decimals.
SELECT detail->>'chainId' AS chain_id, lower(detail->>'token') AS token,
       lower(detail->>'treasury') AS recorded_treasury,
       detail->>'decimals' AS recorded_decimals,
       count(*) AS deposits, sum(delta)::text AS points,
       min(created_at) AS first_deposit, max(created_at) AS last_deposit
FROM credit_entries
WHERE reason = 'deposit' AND delta > 0 AND owner <> 'aiki:issuance'
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;

SELECT reason, count(*) AS entries, sum(delta)::text AS net_points
FROM credit_entries GROUP BY reason ORDER BY reason;

SELECT reason, (-sum(delta))::text AS issued_points
FROM credit_entries WHERE owner = 'aiki:issuance'
GROUP BY reason ORDER BY reason;

-- Empty result required: cache drift includes an entry owner with no balance row.
WITH totals AS (SELECT owner, sum(delta) AS points FROM credit_entries GROUP BY owner)
SELECT coalesce(b.owner, t.owner) AS owner, b.balance::text, t.points::text
FROM credit_balances b FULL OUTER JOIN totals t ON t.owner = b.owner
WHERE coalesce(b.balance, 0) <> coalesce(t.points, 0) OR b.owner IS NULL;

-- Empty result required: every historical payment has one opposite issuance leg,
-- including the repair links added by migration 011 for older deposits.
SELECT p.id, p.owner, p.reference, p.delta::text,
       count(s.id) AS issuance_legs, coalesce(sum(s.delta), 0)::text AS issuance_points
FROM credit_entries p LEFT JOIN credit_entries s
  ON s.owner = 'aiki:issuance' AND s.reason = 'deposit'
 AND (s.reference = p.reference || ':src' OR s.detail->>'repairs' = p.id::text)
WHERE p.reason = 'deposit' AND p.delta > 0 AND p.owner <> 'aiki:issuance'
GROUP BY p.id, p.owner, p.reference, p.delta
HAVING count(s.id) <> 1 OR coalesce(sum(s.delta), 0) <> -p.delta;

-- Empty result required: global hash uniqueness must also survive casing.
SELECT lower(reference) AS transaction_hash, count(*) AS entries
FROM credit_entries WHERE reference ~* '^0x[0-9a-f]{64}$'
GROUP BY lower(reference) HAVING count(*) > 1;

SELECT state, count(*) AS requests, sum(reserved_points)::text AS reserved_points,
       sum(usage_points)::text AS observed_usage_points
FROM assistant_requests
WHERE state = 'UNCONFIRMED' OR (state = 'IN_PROGRESS' AND lease_expires_at <= now())
GROUP BY state ORDER BY state;

SELECT owner, balance::text FROM credit_balances
WHERE owner LIKE 'aiki:%' OR balance < 0 ORDER BY owner;

COMMIT;

-- Uncredited transfers are absent from this ledger and cannot be discovered by
-- SQL. Inventory user-supplied hashes and old-treasury token Transfer logs over
-- a reviewed block range separately. Do not treat zero paid rows as proof that
-- no uncredited funds reached the historical treasury.
