-- Every owner commits business effect, audit and outbox locally.
CREATE TABLE outbox_events (
  event_id UUID PRIMARY KEY,
  aggregate_type STRING NOT NULL CHECK (length(aggregate_type) > 0),
  aggregate_id UUID NOT NULL,
  event_type STRING NOT NULL CHECK (length(event_type) > 0),
  event_version INT8 NOT NULL CHECK (event_version > 0),
  payload JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  status STRING NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'dead_letter')),
  attempts INT8 NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner STRING,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR (status <> 'published' AND published_at IS NULL)),
  CHECK (status <> 'publishing' OR lease_until IS NOT NULL)
);
CREATE INDEX outbox_pending ON outbox_events (status, available_at, lease_until);
CREATE TABLE inbox_events (
  event_id UUID NOT NULL,
  consumer STRING NOT NULL CHECK (length(consumer) > 0),
  event_type STRING NOT NULL CHECK (length(event_type) > 0),
  event_version INT8 NOT NULL CHECK (event_version > 0),
  outcome STRING NOT NULL CHECK (length(outcome) > 0),
  correlation_id UUID NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_reference STRING NOT NULL CHECK (length(actor_reference) > 0),
  action STRING NOT NULL CHECK (length(action) > 0),
  resource_type STRING NOT NULL CHECK (length(resource_type) > 0),
  resource_id UUID NOT NULL,
  outcome STRING NOT NULL CHECK (length(outcome) > 0),
  correlation_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_until TIMESTAMPTZ NOT NULL,
  CHECK (retention_until > occurred_at)
);
CREATE INDEX audit_by_resource ON audit_events (resource_type, resource_id, occurred_at);
