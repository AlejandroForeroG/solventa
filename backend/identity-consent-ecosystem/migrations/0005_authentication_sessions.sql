-- Provider tokens stay in sealed HttpOnly cookies; only opaque references persist.
CREATE TABLE authentication_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  provider STRING NOT NULL,
  provider_session STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  revoked_at TIMESTAMPTZ,
  UNIQUE (provider, provider_session),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_by_client ON authentication_sessions (client_id, expires_at);
