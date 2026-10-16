CREATE TABLE financial_payment_intents (
  policy_id UUID NOT NULL REFERENCES policies(id),
  operation STRING NOT NULL CHECK (operation IN ('premium', 'indemnity')),
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  payment_key STRING NOT NULL,
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (policy_id, operation)
);
