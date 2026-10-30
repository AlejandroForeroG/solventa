CREATE TABLE signature_challenges (
  id UUID PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES policies(id),
  client_id UUID NOT NULL,
  subject_token UUID NOT NULL,
  document_hash STRING NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  code_hash STRING NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  status STRING NOT NULL CHECK (status IN ('active', 'cancelled', 'consumed')),
  command_key STRING CHECK (command_key IS NULL OR command_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signature_challenge_command CHECK ((status = 'consumed') = (command_key IS NOT NULL))
);
CREATE INDEX signature_challenges_policy ON signature_challenges (policy_id, created_at DESC);
