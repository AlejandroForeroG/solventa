-- Only synthetic evidence references and hashes are retained, never image bytes or personal identifiers.
CREATE TABLE identity_verifications (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  is_current BOOL NOT NULL DEFAULT true,
  version INT8 NOT NULL CHECK (version > 0),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  seal STRING NOT NULL CHECK (seal ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, client_id)
);
CREATE UNIQUE INDEX identity_verification_current ON identity_verifications (client_id) WHERE is_current;
CREATE TABLE identity_verification_commands (
  client_id UUID NOT NULL REFERENCES clients(id),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  case_id UUID NOT NULL,
  command JSONB NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  seal STRING NOT NULL CHECK (seal ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, idempotency_key),
  FOREIGN KEY (case_id, client_id) REFERENCES identity_verifications (id, client_id)
);
