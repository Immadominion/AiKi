-- Work somebody posted, that somebody else claims.
--
-- Every job until now was funded against a named agent chosen from a listing:
-- you pick the seller, then you pay. That shape cannot express the thing this
-- table is for, which is an agent posting work and a HUMAN doing it. There is
-- no listing for "read this contract and tell me if the owner is who they say
-- they are", and the person who can do it has no ERC-8004 identity, no URL that
-- answers a probe, and no published price.
--
-- So the seller is not named when the money is committed. The poster funds
-- escrow, the work sits open, and whoever claims it is paid on acceptance. The
-- ledger underneath is the same one hires use, because escrow, fees and refunds
-- do not care what the payee is.
--
-- The safety properties here are deliberate and come from measured abuse of
-- exactly this primitive elsewhere (arXiv 2602.19514, agents hiring humans for
-- account creation at a median $13, identity proxying at $60/hour, OTP
-- solicitation, reconnaissance). Three of that paper's mitigations are enforced
-- by this schema and the routes over it: escrow is locked before the work is
-- visible and cannot be pulled once somebody has claimed it, an agent posting
-- under a mandate spends against that mandate's caps, and a mandate that says
-- to ask a person first holds the post until they answer.
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,

  -- Who wants it done, and under what authority. The authorization is null when
  -- a person posts directly and set when an agent does, which is what makes an
  -- agent's spending on human labour countable against the caps it was given.
  poster TEXT NOT NULL,
  authorization_id UUID REFERENCES authorizations(id),

  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  -- What the work is, chosen from a fixed list rather than typed. A free-text
  -- category cannot be screened, and screening by category is the cheapest
  -- control that exists against the abuse classes above.
  kind TEXT NOT NULL,

  -- Points, on the same ledger hires settle on. price is what the claimant
  -- receives, fee is what AiKi keeps, total is what the poster paid.
  price_points BIGINT NOT NULL CHECK (price_points > 0),
  fee_points BIGINT NOT NULL CHECK (fee_points >= 0),
  total_points BIGINT NOT NULL CHECK (total_points > 0),
  -- Base units of the settlement asset, for cap accounting, on the same
  -- reasoning as jobs.sold_outlay: caps are written in base units and points are
  -- the wrong unit for one by a factor of 10^14.
  outlay NUMERIC(78, 0) NOT NULL DEFAULT 0,

  status TEXT NOT NULL CHECK (
    status IN ('OPEN', 'CLAIMED', 'SUBMITTED', 'SETTLED', 'CANCELLED', 'DISPUTED')
  ),

  -- Who is doing it. Null until claimed, and never reset: a task that changed
  -- hands after a submission would let a poster take the work and pay somebody
  -- else for it.
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,

  -- What they delivered. Whatever the work produces, kept verbatim, because the
  -- poster is about to decide whether to pay for it.
  submission TEXT,
  submitted_at TIMESTAMPTZ,

  -- Why it ended the way it did, when it ended badly.
  resolution TEXT,
  decided_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A claimed task has a claimant and an unclaimed one does not. Stated here so
  -- no route can produce a task that is being worked on by nobody.
  CONSTRAINT tasks_claimant_matches_status CHECK (
    (status = 'OPEN' AND claimed_by IS NULL)
    OR (status = 'CANCELLED' AND (claimed_by IS NULL OR claimed_by IS NOT NULL))
    OR (status IN ('CLAIMED', 'SUBMITTED', 'SETTLED', 'DISPUTED') AND claimed_by IS NOT NULL)
  ),
  -- Nobody is paid for work that was never handed in.
  CONSTRAINT tasks_settled_has_submission CHECK (
    status <> 'SETTLED' OR submission IS NOT NULL
  )
);

-- The board: what is open, newest first.
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (created_at DESC) WHERE status = 'OPEN';
-- What I posted, and what I am doing.
CREATE INDEX IF NOT EXISTS tasks_poster ON tasks (poster, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_claimant ON tasks (claimed_by, created_at DESC)
  WHERE claimed_by IS NOT NULL;
