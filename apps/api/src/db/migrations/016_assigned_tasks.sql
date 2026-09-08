-- Work given to one named agent, and dispatched to it.
--
-- Hiring an agent could take money and pay it out and never ask the agent for
-- anything. Of the states a job can be in, DISPATCHED and COMPLETED were
-- written by no code at all: a buyer funded, and then decided to settle, for
-- work AiKi never requested and never saw. The marketplace could sell a thing
-- it never asked anybody to make.
--
-- Rather than a second delivery state machine beside the task board's, a hire
-- IS a task with the claimant decided in advance. Everything that already works
-- keeps working unchanged: the escrow, the two deadlines, accepting, declining,
-- and the claimant releasing payment when the poster goes quiet. The only new
-- things are who it is for and what happened when we called them.
--
-- An assigned agent has no AiKi account and never will: it is a URL in an
-- ERC-8004 registration document. So AiKi calls that URL and records the answer
-- on the agent's behalf, and `claimed_by` holds the address its registry entry
-- names as owner, which is who the money reaches.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_agent_id TEXT;

-- When we called it, and what happened if the call did not work. Kept because
-- an agent that cannot be reached is a fact about that agent, and this is a
-- product whose whole claim is that it measures such facts rather than
-- repeating what agents say about themselves.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_note TEXT;

-- Assigned work is not on the public board, so the board index should not carry
-- it. Its own index instead, for showing an agent's order book.
CREATE INDEX IF NOT EXISTS tasks_assigned ON tasks (assigned_agent_id, created_at DESC)
  WHERE assigned_agent_id IS NOT NULL;
