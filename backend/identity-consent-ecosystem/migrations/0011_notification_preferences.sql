CREATE TABLE notification_preferences (
  client_id UUID PRIMARY KEY REFERENCES clients(id),
  version INT8 NOT NULL CHECK (version > 0),
  preferences JSONB NOT NULL CHECK (jsonb_typeof(preferences) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_preference_commands (
  client_id UUID NOT NULL REFERENCES clients(id),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_version INT8 NOT NULL CHECK (result_version > 0),
  result_preferences JSONB NOT NULL CHECK (jsonb_typeof(result_preferences) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, idempotency_key)
);
