-- Offer and subject references cross contracts, not SQL ownership boundaries.
CREATE TABLE policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  offer_id UUID NOT NULL,
  offer_version INT8 NOT NULL CHECK (offer_version > 0),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash STRING NOT NULL CHECK (length(request_hash) = 64),
  status STRING NOT NULL DEFAULT 'pending' CHECK (length(status) > 0),
  premium DECIMAL(19,4) NOT NULL CHECK (premium >= 0),
  currency STRING NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  coverage_snapshot JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ NOT NULL,
  correlation_id UUID NOT NULL,
  version INT8 NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_token, idempotency_key),
  CHECK (effective_until > effective_from)
);
CREATE TABLE claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES policies(id),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash STRING NOT NULL CHECK (length(request_hash) = 64),
  status STRING NOT NULL DEFAULT 'pending' CHECK (length(status) > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id UUID NOT NULL,
  version INT8 NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, idempotency_key),
  UNIQUE (id, policy_id)
);
CREATE TABLE indemnities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  amount DECIMAL(19,4) NOT NULL CHECK (amount >= 0),
  currency STRING NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status STRING NOT NULL DEFAULT 'pending' CHECK (length(status) > 0),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, policy_id) REFERENCES claims (id, policy_id),
  UNIQUE (id, policy_id)
);
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES policies(id),
  indemnity_id UUID,
  operation STRING NOT NULL CHECK (operation IN ('premium', 'indemnity')),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash STRING NOT NULL CHECK (length(request_hash) = 64),
  amount DECIMAL(19,4) NOT NULL CHECK (amount > 0),
  currency STRING NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider STRING,
  provider_reference STRING,
  status STRING NOT NULL DEFAULT 'pending' CHECK (length(status) > 0),
  correlation_id UUID NOT NULL,
  version INT8 NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, operation, idempotency_key),
  UNIQUE (provider, provider_reference),
  FOREIGN KEY (indemnity_id, policy_id) REFERENCES indemnities (id, policy_id),
  CHECK ((operation = 'premium' AND indemnity_id IS NULL) OR (operation = 'indemnity' AND indemnity_id IS NOT NULL))
);
CREATE TABLE evidence_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES claims(id),
  object_key STRING NOT NULL UNIQUE CHECK (length(object_key) > 0),
  content_type STRING NOT NULL CHECK (length(content_type) > 0),
  byte_size INT8 NOT NULL CHECK (byte_size > 0),
  checksum_sha256 STRING NOT NULL CHECK (length(checksum_sha256) = 64),
  state STRING NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploaded', 'verified')),
  retention_until TIMESTAMPTZ NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  CHECK (retention_until > created_at),
  CHECK ((state = 'verified' AND verified_at IS NOT NULL) OR (state <> 'verified' AND verified_at IS NULL))
);
