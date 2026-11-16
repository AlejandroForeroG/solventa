-- Customer approvals and revocations are append-only and owned by Policy.
CREATE TABLE advisor_authorizations (
  id UUID PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES policies(id),
  owner_id UUID NOT NULL,
  owner_subject UUID NOT NULL,
  advisor_id UUID NOT NULL,
  advisor_subject UUID NOT NULL,
  advisor_reference UUID NOT NULL,
  command_key STRING NOT NULL CHECK (command_key ~ '^[0-9a-f]{64}$'),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(owner_id, command_key),
  CHECK (owner_id <> advisor_id),
  CHECK (expires_at > granted_at AND expires_at <= granted_at + INTERVAL '7 days')
);
CREATE INDEX advisor_authorizations_for_owner ON advisor_authorizations(owner_id, policy_id, granted_at DESC, id DESC);
CREATE INDEX advisor_authorizations_for_advisor ON advisor_authorizations(advisor_id, granted_at DESC, id DESC);
CREATE TABLE advisor_authorization_revocations (
  authorization_id UUID PRIMARY KEY REFERENCES advisor_authorizations(id),
  actor_id UUID NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE advisor_lifecycle_executions (
  change_id UUID PRIMARY KEY REFERENCES policy_lifecycle_changes(change_id),
  authorization_id UUID NOT NULL UNIQUE REFERENCES advisor_authorizations(id),
  owner_id UUID NOT NULL,
  advisor_id UUID NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CHECK(owner_id <> advisor_id)
);
