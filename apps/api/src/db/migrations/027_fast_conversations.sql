CREATE TABLE fast_conversations (
  id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (owner = lower(owner)),
  title text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fast_conversations_owner_updated ON fast_conversations (owner, updated_at DESC, id DESC);

CREATE TABLE fast_conversation_turns (
  turn_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES fast_conversations(id),
  user_content text NOT NULL,
  reply text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]',
  cost jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fast_conversation_turns_order ON fast_conversation_turns (conversation_id, created_at, turn_id);
