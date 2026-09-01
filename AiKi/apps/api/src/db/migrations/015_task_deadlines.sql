-- Nobody's money sits still because somebody stopped answering.
--
-- The board shipped with two ways to strand funds and no way out of either.
-- Claim a task and never hand it in, and the poster's money is locked behind a
-- person who has gone quiet: cancelling is refused from CLAIMED on purpose, so
-- there was no route at all. And hand work in to a poster who never answers,
-- and the person who actually did the work waits forever while the money sits
-- in escrow with their name nowhere near it.
--
-- Both are fixed with a clock rather than a person. Two windows, and each one
-- protects the side that is not holding the initiative:
--
--   claim_expires_at   how long the claimant has to hand something in. When it
--                      passes the task is claimable again, so the work goes
--                      back on the board instead of the money going nowhere.
--
--   review_expires_at  how long the poster has to accept or decline. When it
--                      passes the claimant can take the payment themselves.
--                      Silence from the person holding the goods is not a
--                      reason the person who made them goes unpaid.
--
-- The review window is deliberately not settable by the poster. They benefit
-- from it being long, and a limit whose length is chosen by the party it
-- constrains is not a limit.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_expires_at TIMESTAMPTZ;

-- How long a claimant gets, chosen by the poster when the work is posted,
-- because only they know whether it is twenty minutes or two days of work.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_hours INT NOT NULL DEFAULT 48
  CHECK (work_hours BETWEEN 1 AND 720);

-- Finding what has lapsed, without reading the whole table.
CREATE INDEX IF NOT EXISTS tasks_claim_deadline ON tasks (claim_expires_at)
  WHERE status = 'CLAIMED';
CREATE INDEX IF NOT EXISTS tasks_review_deadline ON tasks (review_expires_at)
  WHERE status = 'SUBMITTED';
