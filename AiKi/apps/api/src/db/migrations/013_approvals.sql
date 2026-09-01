-- Actions waiting for a person to say yes.
--
-- The hire screen has offered four approval modes since the beginning: act
-- without asking, tell me as it happens, ask me over an amount, ask me every
-- time. Three of those four described something that did not exist. The choice
-- was never sent to the API, the API had no concept of approval, and Settings
-- said of approval requests "This is the one thing we will not let you silence"
-- about a setting that reached no server. A person could ask to be asked, and
-- the agent would act without asking.
--
-- This is the record of what is waiting. The runner ticks on a schedule, so an
-- action that needs approval is refused on the tick that raises it and goes
-- through on a later tick once somebody has said yes. Nothing is held in
-- memory between the two, which is what makes it survive a restart.
CREATE TABLE IF NOT EXISTS job_approvals (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  authorization_id UUID NOT NULL REFERENCES authorizations(id),

  -- Enough of the action for a person to know what they are agreeing to. A
  -- request that says "the agent wants to do something" is not an approval, it
  -- is a dare.
  target TEXT NOT NULL,
  selector TEXT NOT NULL,
  asset TEXT NOT NULL,
  -- uint256 base units. NUMERIC(78,0) for the same reason authorizations.spent
  -- uses it: a token amount does not fit in BIGINT.
  amount NUMERIC(78, 0) NOT NULL CHECK (amount >= 0),
  -- Why the agent wants to, in its own words, kept verbatim.
  reason TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'used')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- One pending request per action, however many times the runner ticks.
-- Without this a watch checking every minute would raise sixty identical
-- requests an hour and a person would be asked the same question until they
-- stopped reading any of them.
CREATE UNIQUE INDEX IF NOT EXISTS job_approvals_one_pending
  ON job_approvals (job_id, target, selector, asset, amount)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS job_approvals_job
  ON job_approvals (job_id, requested_at DESC);

-- What is waiting for me, across every job, without reading them all.
CREATE INDEX IF NOT EXISTS job_approvals_waiting
  ON job_approvals (authorization_id, requested_at DESC) WHERE status = 'pending';
