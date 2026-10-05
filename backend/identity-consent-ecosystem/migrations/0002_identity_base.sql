-- Identifiers are opaque. No passwords, bearer tokens or raw PII are stored here.
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_token STRING NOT NULL UNIQUE CHECK (length(subject_token) > 0),
  status STRING NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  version INT8 NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  provider STRING NOT NULL CHECK (length(provider) > 0),
  provider_subject STRING NOT NULL CHECK (length(provider_subject) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code STRING NOT NULL UNIQUE CHECK (length(code) > 0),
  status STRING NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE partner_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  provider STRING NOT NULL CHECK (length(provider) > 0),
  credential_reference STRING NOT NULL CHECK (length(credential_reference) > 0),
  scopes STRING[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, credential_reference),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
-- Append a new revision for changes to purpose, scope or validity. Revocation
-- is recorded on the existing revision and must be checked on every use.
CREATE TABLE consents (
  id UUID NOT NULL,
  version INT8 NOT NULL CHECK (version > 0),
  client_id UUID NOT NULL REFERENCES clients(id),
  partner_id UUID REFERENCES partners(id),
  purpose STRING NOT NULL CHECK (length(purpose) > 0),
  scopes STRING[] NOT NULL CHECK (array_length(scopes, 1) > 0),
  source STRING NOT NULL CHECK (length(source) > 0),
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  PRIMARY KEY (id, version),
  CHECK (expires_at > granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX consents_by_client ON consents (client_id, purpose, expires_at);
CREATE TABLE registered_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  device_reference STRING NOT NULL CHECK (length(device_reference) > 0),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (client_id, device_reference),
  CHECK (revoked_at IS NULL OR revoked_at >= registered_at)
);
