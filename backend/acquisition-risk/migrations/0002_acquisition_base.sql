-- Cross-domain subjects, partners and consents are opaque contract references,
-- never foreign keys into Identity's schema.
CREATE TABLE quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  partner_id UUID NOT NULL,
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash STRING NOT NULL CHECK (length(request_hash) = 64),
  normalized_request JSONB NOT NULL,
  rule_version STRING NOT NULL CHECK (length(rule_version) > 0),
  result JSONB,
  status STRING NOT NULL DEFAULT 'pending' CHECK (length(status) > 0),
  degradation_reason STRING,
  correlation_id UUID NOT NULL,
  version INT8 NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, subject_token, idempotency_key)
);
CREATE TABLE risk_profiles (
  id UUID NOT NULL,
  version INT8 NOT NULL CHECK (version > 0),
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  source STRING NOT NULL CHECK (length(source) > 0),
  captured_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  quality STRING NOT NULL CHECK (length(quality) > 0),
  purpose STRING NOT NULL CHECK (length(purpose) > 0),
  consent_id UUID NOT NULL,
  consent_version INT8 NOT NULL CHECK (consent_version > 0),
  signals JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  PRIMARY KEY (id, version),
  CHECK (expires_at > captured_at)
);
CREATE INDEX risk_profiles_by_subject ON risk_profiles (subject_token, purpose, captured_at DESC);
CREATE TABLE underwriting_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id),
  rule_version STRING NOT NULL CHECK (length(rule_version) > 0),
  contract_version STRING NOT NULL CHECK (length(contract_version) > 0),
  outcome STRING NOT NULL CHECK (length(outcome) > 0),
  explanation JSONB NOT NULL,
  -- Immutable input snapshot/references required for historical reconstruction.
  input_snapshot JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT8 NOT NULL DEFAULT 1 CHECK (version > 0),
  decision_id UUID NOT NULL REFERENCES underwriting_decisions(id),
  premium DECIMAL(19,4) NOT NULL CHECK (premium >= 0),
  currency STRING NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  coverages JSONB NOT NULL,
  status STRING NOT NULL DEFAULT 'preliminary' CHECK (status IN ('preliminary', 'definitive', 'expired', 'withdrawn')),
  valid_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > valid_from)
);
CREATE TABLE signal_refresh_jobs (
  event_id UUID PRIMARY KEY,
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  purpose STRING NOT NULL CHECK (length(purpose) > 0),
  scopes STRING[] NOT NULL CHECK (array_length(scopes, 1) > 0),
  consent_id UUID NOT NULL,
  consent_version INT8 NOT NULL CHECK (consent_version > 0),
  status STRING NOT NULL DEFAULT 'pending' CHECK (length(status) > 0),
  attempts INT8 NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expected_profile_version INT8 CHECK (expected_profile_version > 0),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
