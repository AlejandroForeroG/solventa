CREATE TABLE financial_contracts (
  policy_id UUID PRIMARY KEY REFERENCES policies(id),
  client_id UUID NOT NULL,
  acceptance_id UUID NOT NULL UNIQUE,
  acceptance_event_id UUID NOT NULL UNIQUE,
  terms JSONB NOT NULL,
  terms_hash STRING NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  document STRING NOT NULL,
  document_hash STRING NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  decision_capture JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE financial_commands (
  actor_id UUID NOT NULL,
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  policy_id UUID NOT NULL REFERENCES policies(id),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, idempotency_key)
);
CREATE TABLE policy_signatures (
  policy_id UUID PRIMARY KEY REFERENCES policies(id),
  document_hash STRING NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  provider STRING NOT NULL CHECK (provider = 'synthetic-signature-v1'),
  receipt STRING NOT NULL CHECK (receipt ~ '^[0-9a-f]{64}$'),
  signed_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE inbox_events ADD COLUMN payload_hash STRING CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE inbox_events ADD COLUMN policy_id UUID REFERENCES policies(id);
-- This is the explicitly synthetic provider's durable ledger, not a real charge.
CREATE TABLE mock_gateway_operations (
  payment_id UUID PRIMARY KEY REFERENCES payments(id),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation STRING NOT NULL CHECK (operation IN ('premium', 'indemnity')),
  amount DECIMAL(19,4) NOT NULL CHECK (amount > 0),
  currency STRING NOT NULL CHECK (currency = 'COP'),
  status STRING NOT NULL CHECK (status IN ('confirmed', 'refunded')),
  provider_reference STRING NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
