-- Flight offers do not reuse a mortgage quote. Existing decisions retain their quote foreign key.
ALTER TABLE underwriting_decisions ALTER COLUMN quote_id DROP NOT NULL;
CREATE TABLE offer_contexts (
  offer_id UUID PRIMARY KEY REFERENCES offers(id),
  quote_id UUID REFERENCES quotes(id),
  client_id UUID NOT NULL,
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  source_reference STRING NOT NULL,
  terms JSONB NOT NULL,
  terms_seal STRING NOT NULL CHECK (terms_seal ~ '^[a-f0-9]{64}$'),
  consent_reference STRING NOT NULL,
  consent_version INT8 NOT NULL CHECK (consent_version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, idempotency_key)
);
CREATE TABLE offer_acceptances (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL UNIQUE REFERENCES offers(id),
  client_id UUID NOT NULL,
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  event_id UUID NOT NULL UNIQUE,
  accepted_at TIMESTAMPTZ NOT NULL,
  result JSONB NOT NULL,
  UNIQUE (client_id, idempotency_key)
);
