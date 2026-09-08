-- One mandate account per person per chain.
--
-- A mandate needs somewhere for the value to live, and that somewhere belongs to
-- exactly one person: the contract's constructor names them as owner and the
-- manager as its only executor. AiKi pays the gas to deploy it and holds nothing
-- afterwards, so this table records whose account is where, not who controls it.
CREATE TABLE IF NOT EXISTS mandate_accounts (
  -- Lowercased, because an address compared case-sensitively is two addresses
  -- and somebody would quietly get a second account on their next visit.
  owner TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  deployed_tx TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The constraint is the point: two requests racing to create an account for
  -- the same person must not both succeed, or their mandates would be split
  -- across two accounts and half their limits would sit against the wrong one.
  PRIMARY KEY (owner, chain_id)
);
