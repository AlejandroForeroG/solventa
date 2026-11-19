-- A customer's own, revocable permission for one advisor to prepare one kind of sale on their behalf.
-- The advisor only learns the row id; the customer behind it is resolved by Identity on every use.
CREATE TABLE advisor_sale_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advisor_grant_id UUID NOT NULL REFERENCES policy_advisor_grants(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  operation STRING NOT NULL CHECK (operation IN ('advisor-sale:prepare')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > granted_at AND expires_at <= granted_at + INTERVAL '7 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX advisor_sale_authorizations_by_client ON advisor_sale_authorizations (client_id, granted_at DESC);
