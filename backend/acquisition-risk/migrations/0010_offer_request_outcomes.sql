-- One append-only first outcome, including declines, per authenticated actor and request key.
CREATE TABLE offer_requests (
  client_id UUID NOT NULL,
  subject_token STRING NOT NULL CHECK (length(subject_token) > 0),
  idempotency_key STRING NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_identity STRING NOT NULL CHECK (length(request_identity) BETWEEN 1 AND 256),
  outcome STRING NOT NULL CHECK (outcome IN ('accepted', 'declined')),
  decision_id UUID NOT NULL REFERENCES underwriting_decisions(id),
  offer_id UUID REFERENCES offers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, idempotency_key),
  CHECK ((outcome = 'accepted' AND offer_id IS NOT NULL) OR (outcome = 'declined' AND offer_id IS NULL))
);
