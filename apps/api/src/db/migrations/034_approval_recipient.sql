-- Where the money was going, on the question a person actually answered.
--
-- An approval has always been matched on (job, target, selector, asset, amount)
-- and never on the destination, because until token mandates existed the only
-- action that could need one was a Venus repayment, which names nobody: the
-- money goes to the lending market the target already identifies.
--
-- That stopped being true the moment an agent could be authorised to send a
-- token. Two sends of the same amount of the same token to two different
-- addresses are the same row under the old key, so one "yes" authorised the
-- other, and the approval screen never showed the field that decides whether a
-- person would have said yes at all.
--
-- NULL is the honest value for an action that names no destination, and it is
-- treated as a distinct value rather than a wildcard: a repayment approval must
-- not satisfy a transfer, and a transfer approval must not satisfy a repayment.
-- Postgres treats NULLs as distinct in a unique index by default, which is the
-- wrong behaviour here, so the index below coalesces to a sentinel that no
-- address can equal.
ALTER TABLE job_approvals ADD COLUMN IF NOT EXISTS recipient TEXT;

-- One pending request per action, destination included. Replaces the index that
-- keyed on everything but the destination, under which two sends differing only
-- in where they went collided and the second was silently folded into the first.
DROP INDEX IF EXISTS job_approvals_one_pending;
CREATE UNIQUE INDEX IF NOT EXISTS job_approvals_one_pending
  ON job_approvals (job_id, target, selector, asset, amount, COALESCE(lower(recipient), ''))
  WHERE status = 'pending';
