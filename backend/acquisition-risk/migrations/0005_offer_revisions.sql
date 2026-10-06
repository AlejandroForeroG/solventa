-- Offers is the current projection. Contractual terms are append-only by revision.
CREATE TABLE offer_revisions (
  offer_id UUID NOT NULL REFERENCES offers(id),
  version INT8 NOT NULL CHECK (version > 0),
  decision_id UUID NOT NULL REFERENCES underwriting_decisions(id),
  premium DECIMAL(19,4) NOT NULL CHECK (premium >= 0),
  currency STRING NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  coverages JSONB NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, version),
  CHECK (expires_at > valid_from)
);
