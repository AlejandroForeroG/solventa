-- A customer's own, revocable permission for one partner to request one operation on their behalf.
-- The partner only learns the row id; the customer behind it is resolved by Identity on every use.
CREATE TABLE partner_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  operation STRING NOT NULL CHECK (operation IN ('partner-offers:create')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > granted_at AND expires_at <= granted_at + INTERVAL '90 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX partner_authorizations_by_client ON partner_authorizations (client_id, granted_at DESC);
