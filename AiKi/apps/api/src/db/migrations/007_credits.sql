-- What somebody has bought the right to use, and every reason the number moved.
--
-- Fast mode costs real money to run: a model reads the question, calls tools and
-- writes an answer, and someone pays the provider for those tokens. A
-- subscription would charge people who ask two questions a month the same as
-- people who ask two hundred, so this is a balance instead, denominated in
-- points and drawn down by actual usage.
--
-- Two tables and not one, because a balance nobody can explain is a balance
-- nobody trusts. The ledger is the truth; the balance is a running total kept
-- alongside it so a chat turn does not have to sum a person's whole history.
CREATE TABLE IF NOT EXISTS credit_balances (
  -- Lowercased. An address compared case-sensitively is two people, and one of
  -- them would find their points missing.
  owner TEXT PRIMARY KEY,
  -- Whole points. Never fractional and never negative: a turn that would take
  -- somebody below zero is refused before it runs, not settled afterwards.
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_entries (
  id UUID PRIMARY KEY,
  owner TEXT NOT NULL,
  -- Positive for a deposit, negative for usage. Signed rather than a separate
  -- kind column, so the balance is provably SUM(delta) and nothing else.
  delta BIGINT NOT NULL,
  reason TEXT NOT NULL,
  -- What this entry points at, and the reason deposits cannot be replayed: the
  -- transaction hash of a deposit is unique, so crediting the same payment
  -- twice is a constraint violation rather than free money.
  reference TEXT,
  -- Whatever made the number move, kept verbatim: the model and token counts for
  -- a usage entry, the chain and amount for a deposit. A person asking "why did
  -- that cost 140 points" gets an answer instead of a shrug.
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One credit per payment, forever.
CREATE UNIQUE INDEX IF NOT EXISTS credit_entries_reference
  ON credit_entries (reference) WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_entries_owner
  ON credit_entries (owner, created_at DESC);
