CREATE TABLE partner_portal_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  partner_id UUID NOT NULL REFERENCES partners(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  granted_by UUID NOT NULL,
  CHECK (expires_at > granted_at AND expires_at <= granted_at + INTERVAL '90 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX partner_portal_grants_current ON partner_portal_grants (client_id) WHERE revoked_at IS NULL;
