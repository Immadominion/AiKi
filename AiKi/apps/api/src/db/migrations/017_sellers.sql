-- People who can be hired, rather than only people who can claim.
--
-- The board let an agent post work and wait for somebody to take it. That is
-- one half of hiring a person and not the half anybody asks for first: an agent
-- that needs somebody who reads Mandarin contracts has no way to FIND one, only
-- to describe the work and hope. Meanwhile the only thing on AiKi that can be
-- looked up and hired directly is an ERC-8004 token, which a person does not
-- have and is not getting.
--
-- So a seller here is an address, a sentence about what they do, and the kinds
-- of work they take, from the same fixed list a task is posted under. No
-- identity claims, no CV, nothing anybody has to believe: what makes a listing
-- worth anything is the record of work settled through it, which is measured
-- rather than asserted, on the same principle as everything else in this
-- product.
CREATE TABLE IF NOT EXISTS sellers (
  address TEXT PRIMARY KEY,
  -- What to call them. Not verified and not presented as if it were: anybody
  -- may type anything here, and the thing that carries weight is below.
  name TEXT NOT NULL,
  blurb TEXT NOT NULL,
  -- Kinds they take, from the allowlist tasks are posted under. Stored as an
  -- array so hiring can filter on it, and constrained by the same list, so
  -- there is no kind somebody can offer that nobody can ask for.
  kinds TEXT[] NOT NULL DEFAULT '{}',
  -- What they want for a piece of work, in points. A starting figure, not a
  -- promise: the price of any actual task is whatever the hire says it is.
  rate_points BIGINT NOT NULL DEFAULT 0 CHECK (rate_points >= 0),
  -- Off means they are not taking work now. Better than deleting a listing and
  -- losing the record attached to it.
  available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sellers_available ON sellers (updated_at DESC) WHERE available;

-- Work hired directly, whether from an agent or a person.
--
-- `assigned_agent_id` already marked an agent hire, and it is doing two jobs:
-- naming who to dispatch to, and meaning "this was never open to the board".
-- A person cannot be dispatched to, so the second meaning needs its own column
-- or a direct hire of a person would appear on the public board the moment its
-- deadline passed, and somebody else could take work that was commissioned.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS direct_hire BOOLEAN NOT NULL DEFAULT false;
UPDATE tasks SET direct_hire = true WHERE assigned_agent_id IS NOT NULL AND NOT direct_hire;
