-- Give every point that moved a place it came from and a place it went.
--
-- Measured on production before this ran: six reasons had moved points and not
-- one of them summed to zero. A deposit credited somebody and debited nothing;
-- a Fast mode turn debited somebody and credited nothing; funding a job took
-- 1,025 points from a buyer and put them in no account at all. The totals still
-- looked plausible, which is the dangerous part, because it meant a job that
-- had taken a buyer's money and paid nobody was indistinguishable from a job
-- that had settled correctly.
--
-- Two house accounts make the missing side nameable:
--   aiki:issuance  what AiKi has put into people's hands and not been paid back
--                  in work. Negative by design, and the only account allowed to
--                  be, because its negative balance IS the liability.
--   aiki:revenue   what has been consumed. A Fast mode turn costs real money at
--                  a model provider, and that is a destination, not a deletion.
-- aiki:escrow already existed and now actually receives the money it holds.

-- Escrow must never go below zero: an overdrawn escrow is a payout drawing on
-- money nobody funded. Issuance is the single exception.
ALTER TABLE credit_balances DROP CONSTRAINT IF EXISTS credit_balances_balance_check;
ALTER TABLE credit_balances ADD CONSTRAINT credit_balances_balance_check
  CHECK (balance >= 0 OR owner = 'aiki:issuance');

-- Refuse to guess. A reason this migration has no counterparty rule for would
-- otherwise be repaired into the wrong account, which is worse than not
-- repairing it, so the whole migration fails and says which reason it was.
DO $$
DECLARE unknown TEXT;
BEGIN
  SELECT string_agg(DISTINCT reason, ', ') INTO unknown
    FROM credit_entries
   WHERE owner NOT LIKE 'aiki:%'
     AND reason NOT IN (
       'deposit', 'welcome', 'fast_mode',
       'job_funding', 'job_earnings', 'platform_fee', 'job_refund'
     );
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'No counterparty rule for reason(s): %', unknown;
  END IF;
END $$;

-- The side that was never written, one row per existing entry, keyed on the
-- entry it repairs so running this twice writes nothing the second time.
INSERT INTO credit_entries (id, owner, delta, reason, reference, detail, created_at)
SELECT
  gen_random_uuid(),
  CASE
    -- Issued: the points entered circulation here.
    WHEN e.reason IN ('deposit', 'welcome') THEN 'aiki:issuance'
    -- Consumed: the points paid for a model turn AiKi was billed for.
    WHEN e.reason = 'fast_mode' THEN 'aiki:revenue'
    -- Held: every leg of a sale passes through the account that holds it.
    ELSE 'aiki:escrow'
  END,
  -e.delta,
  e.reason,
  'repair:' || e.id,
  jsonb_build_object(
    'repairs', e.id,
    'why', 'the counterparty leg the single-sided ledger never wrote'
  ),
  e.created_at
FROM credit_entries e
WHERE e.owner NOT LIKE 'aiki:%'
  -- Legs written by the double-entry code already have their partner; they are
  -- recognisable by the suffix the code puts on every reference it pairs.
  AND (e.reference IS NULL OR e.reference NOT LIKE '%:out')
  AND NOT EXISTS (
    SELECT 1 FROM credit_entries p
     WHERE p.owner LIKE 'aiki:%'
       AND e.reference IS NOT NULL
       AND p.reference IN (e.reference || ':src', e.reference || ':dst')
  )
  AND NOT EXISTS (
    SELECT 1 FROM credit_entries r WHERE r.reference = 'repair:' || e.id
  );

-- Money taken for work that was never delivered goes back.
--
-- One job on production was funded twice for 1,025 points each by a
-- check-then-act race, and neither charge recorded what was being bought, so
-- the settle and refund routes written afterwards could not act on it: 2,050
-- points sat debited from a buyer and owed to nobody. Returning it is the only
-- honest answer. Stated generally rather than by job id, so it covers every
-- funding taken before escrow existed.
CREATE TEMP TABLE orphan_funding ON COMMIT DROP AS
SELECT f.id, f.owner, -f.delta AS points, f.detail->>'jobId' AS job_id
  FROM credit_entries f
 WHERE f.reason = 'job_funding'
   AND f.reference IS NULL
   AND f.delta < 0
   -- Settled fundings are accounted for: the seller and the treasury have it.
   AND NOT EXISTS (
     SELECT 1 FROM credit_entries s
      WHERE s.reason = 'job_earnings'
        AND s.detail->>'jobId' = f.detail->>'jobId'
   )
   AND NOT EXISTS (
     SELECT 1 FROM credit_entries r WHERE r.reference = 'repair-refund:' || f.id
   );

INSERT INTO credit_entries (id, owner, delta, reason, reference, detail)
SELECT gen_random_uuid(), o.owner, o.points, 'job_refund',
       'repair-refund:' || o.id,
       jsonb_build_object(
         'jobId', o.job_id,
         'because', 'funded before escrow existed and never delivered'
       )
  FROM orphan_funding o;

INSERT INTO credit_entries (id, owner, delta, reason, reference, detail)
SELECT gen_random_uuid(), 'aiki:escrow', -o.points, 'job_refund',
       'repair-refund:' || o.id || ':out',
       jsonb_build_object('jobId', o.job_id, 'repairs', o.id)
  FROM orphan_funding o;

-- The job stops claiming to hold money it no longer holds.
UPDATE jobs SET status = 'CANCELLED', updated_at = now()
 WHERE status = 'FUNDED'
   AND id::text IN (SELECT job_id FROM orphan_funding);

INSERT INTO job_events (job_id, type, detail, at)
SELECT o.job_id::uuid, 'status',
       'Refunded ' || o.points || ' points: funded before escrow existed, never delivered.',
       now()
  FROM orphan_funding o
 WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id::text = o.job_id);

-- The balance column is a cache of the entries, so rebuild it from them rather
-- than trying to keep two sets of arithmetic in step through a repair.
INSERT INTO credit_balances (owner, balance, updated_at)
SELECT owner, sum(delta), now() FROM credit_entries GROUP BY owner
ON CONFLICT (owner) DO UPDATE
  SET balance = EXCLUDED.balance, updated_at = now();

-- And nothing may be left over: a balance row with no entries behind it is the
-- drift this whole migration exists to remove.
UPDATE credit_balances SET balance = 0, updated_at = now()
 WHERE owner NOT IN (SELECT owner FROM credit_entries) AND balance <> 0;
