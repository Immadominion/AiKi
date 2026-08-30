-- What an agent is keeping an eye on, and when it last looked.
--
-- A mandate says what an agent may do; a watch is the reason it ever wakes up.
-- Without one, an agent only acts when a person clicks something, which is the
-- opposite of the thing being sold: you hire a guardian so that you do not have
-- to be the one watching at 3am.
--
-- One watch per job. A job is already the unit a mandate is spent through, and
-- two watches on one job would race each other through the same cap.
CREATE TABLE IF NOT EXISTS watches (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  authorization_id UUID NOT NULL REFERENCES authorizations(id),

  -- The position under protection. Stored lowercased: an address compared
  -- case-sensitively is two addresses, and the second one has no position.
  account TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  -- 'venus' today. Named rather than assumed, so adding a second protocol is a
  -- new value here and not a silent reinterpretation of every existing row.
  protocol TEXT NOT NULL,

  -- The line being defended, as a decimal string ("1.50"). Text, not a float:
  -- this is compared against an 18-decimal on-chain number, and binary floating
  -- point cannot hold 1.1 exactly.
  minimum_health_factor TEXT NOT NULL,
  -- What gets repaid, and the market it is repaid into.
  asset TEXT NOT NULL,
  repay_to TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Separate on purpose. "Looked and all was well" and "did something" are
  -- different facts, and collapsing them leaves a user unable to tell a healthy
  -- quiet watch from one that stopped running three days ago.
  last_checked_at TIMESTAMPTZ,
  last_acted_at TIMESTAMPTZ,
  -- Why the last pass decided what it did, in the agent's own words. A watch
  -- that never acts still has to be able to account for itself.
  last_reason TEXT
);

-- The sweep's only query: active watches, oldest look first. Partial, because
-- stopped watches are never swept and there is no reason to carry them.
CREATE INDEX IF NOT EXISTS watches_due
  ON watches (last_checked_at NULLS FIRST)
  WHERE status = 'active';
