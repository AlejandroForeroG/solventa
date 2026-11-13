-- Editable reports are not filed claims. Commands and immutable revisions retain uncertain results and conflict history.
CREATE TABLE claim_drafts (
  id UUID PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES policies(id),
  owner_id UUID NOT NULL,
  owner_subject UUID NOT NULL,
  revision INT4 NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  content JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX claim_drafts_by_owner ON claim_drafts (owner_subject, updated_at DESC, id);
CREATE TABLE claim_draft_revisions (
  draft_id UUID NOT NULL REFERENCES claim_drafts(id),
  revision INT4 NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  content JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  actor_id UUID NOT NULL,
  PRIMARY KEY (draft_id, revision)
);
CREATE TABLE claim_draft_commands (
  owner_subject UUID NOT NULL,
  command_id UUID NOT NULL,
  draft_id UUID NOT NULL REFERENCES claim_drafts(id),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_subject, command_id)
);
