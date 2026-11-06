CREATE TABLE claims_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  operation STRING NOT NULL CHECK (operation IN ('claims:read', 'claims:decide')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  granted_by STRING NOT NULL CHECK (length(granted_by) > 0),
  CHECK (expires_at > granted_at AND expires_at <= granted_at + INTERVAL '90 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX claims_access_grants_by_client ON claims_access_grants (client_id, operation, expires_at DESC) WHERE revoked_at IS NULL;
