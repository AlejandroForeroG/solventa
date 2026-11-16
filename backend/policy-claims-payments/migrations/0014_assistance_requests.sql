-- A customer's request for assistance on site. The provider is a snapshot of the directory entry at the moment of the request, so a later change of the
-- directory never rewrites what the customer confirmed. Requests are never updated or deleted by the runtime role: following one means reading it.
CREATE TABLE assistance_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference STRING NOT NULL UNIQUE CHECK (reference ~ '^ASI-[0-9A-HJKMNP-TV-Z]{8}$'),
  subject_token UUID NOT NULL,
  client_id UUID NOT NULL,
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash STRING NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id STRING NOT NULL CHECK (provider_id ~ '^demo-[a-z0-9-]{1,48}$'),
  provider_kind STRING NOT NULL CHECK (provider_kind IN ('workshop', 'expert', 'roadside')),
  provider_name STRING NOT NULL CHECK (length(provider_name) BETWEEN 1 AND 160),
  provider_city STRING NOT NULL CHECK (length(provider_city) BETWEEN 1 AND 160),
  provider_address STRING NOT NULL CHECK (length(provider_address) BETWEEN 1 AND 160),
  provider_phone STRING NOT NULL CHECK (provider_phone ~ '^\+[0-9]{8,15}$'),
  provider_hours STRING NOT NULL CHECK (length(provider_hours) BETWEEN 1 AND 160),
  place_kind STRING NOT NULL CHECK (place_kind IN ('device', 'address')),
  latitude NUMERIC(8, 6),
  longitude NUMERIC(9, 6),
  address STRING,
  location_authorized_at TIMESTAMPTZ,
  status STRING NOT NULL DEFAULT 'requested' CHECK (status = 'requested'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_token, idempotency_key),
  CONSTRAINT assistance_request_place CHECK (
    (place_kind = 'device' AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 AND location_authorized_at IS NOT NULL AND address IS NULL)
    OR (place_kind = 'address' AND length(address) BETWEEN 2 AND 160 AND latitude IS NULL AND longitude IS NULL AND location_authorized_at IS NULL))
);
CREATE INDEX assistance_requests_by_owner ON assistance_requests (subject_token, created_at DESC);
