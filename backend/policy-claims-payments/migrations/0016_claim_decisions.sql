CREATE TABLE claim_decisions (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES claims(id),
  actor_id UUID NOT NULL,
  idempotency_key_hash STRING NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash STRING NOT NULL CHECK (length(request_hash) = 64),
  action STRING NOT NULL CHECK (action IN ('approve', 'reject')),
  previous_state STRING NOT NULL,
  resulting_state STRING NOT NULL CHECK (resulting_state IN ('approved', 'rejected')),
  reason STRING NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  evidence_ids JSONB NOT NULL,
  decision_capture JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (claim_id, actor_id, idempotency_key_hash)
);
CREATE INDEX claim_decisions_by_claim ON claim_decisions (claim_id, created_at);
CREATE TABLE claim_review_actions (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES claims(id),
  actor_id UUID NOT NULL,
  key_hash STRING NOT NULL CHECK (length(key_hash) = 64),
  payload_hash STRING NOT NULL CHECK (length(payload_hash) = 64),
  action STRING NOT NULL CHECK (action IN ('take', 'assign_expert', 'request_information', 'respond')),
  resulting_state STRING NOT NULL CHECK (resulting_state IN ('in_review', 'escalated', 'pending_information')),
  reason STRING,
  expert_id STRING,
  expert_name STRING,
  decision_capture JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (claim_id, actor_id, key_hash)
);
CREATE INDEX claim_review_actions_by_claim ON claim_review_actions (claim_id, created_at, id);

CREATE TABLE claim_requirements (
  id UUID PRIMARY KEY REFERENCES claim_review_actions(id),
  claim_id UUID NOT NULL REFERENCES claims(id),
  details STRING NOT NULL CHECK (length(details) BETWEEN 10 AND 1000),
  deadline TIMESTAMPTZ NOT NULL,
  status STRING NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received')),
  response_text STRING,
  response_action UUID REFERENCES claim_review_actions(id),
  received_at TIMESTAMPTZ,
  CHECK ((status = 'received') = (response_action IS NOT NULL AND received_at IS NOT NULL))
);
CREATE INDEX claim_requirements_by_claim ON claim_requirements (claim_id, id);
CREATE UNIQUE INDEX claim_one_pending_requirement ON claim_requirements (claim_id) WHERE status = 'pending';

CREATE TABLE claim_requirement_files (
  requirement_id UUID NOT NULL REFERENCES claim_requirements(id),
  evidence_id UUID NOT NULL UNIQUE REFERENCES evidence_metadata(id),
  included BOOL NOT NULL DEFAULT false,
  PRIMARY KEY (requirement_id, evidence_id)
);

CREATE TABLE claim_notices (
  event_id UUID NOT NULL,
  claim_id UUID NOT NULL REFERENCES claims(id),
  audience STRING NOT NULL CHECK (audience IN ('customer', 'analyst', 'expert')),
  recipient STRING NOT NULL,
  action STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, audience)
);
CREATE INDEX claim_notices_by_recipient ON claim_notices (audience, recipient, created_at DESC, event_id);
