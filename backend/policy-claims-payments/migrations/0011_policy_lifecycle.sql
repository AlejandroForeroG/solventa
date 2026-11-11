-- Issued evidence and confirmed premiums remain immutable. Changes append sealed lifecycle evidence.
CREATE TABLE policy_lifecycle_changes (
  policy_id UUID PRIMARY KEY REFERENCES policies(id),
  change_id UUID NOT NULL UNIQUE,
  actor_id UUID NOT NULL,
  command_key STRING NOT NULL CHECK (command_key ~ '^[0-9a-f]{64}$'),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  replacement_policy_id UUID UNIQUE REFERENCES policies(id),
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_id, command_key),
  CHECK (replacement_policy_id IS NULL OR replacement_policy_id <> policy_id)
);
