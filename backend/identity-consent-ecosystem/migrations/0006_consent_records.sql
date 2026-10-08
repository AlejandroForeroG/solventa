-- Consent records: readable code, text version, every source covered, a seal over the grant and what a grant retry needs.
-- The code counter is a table, not a sequence, because runtime grants are per table.
CREATE TABLE consent_counters (
  year INT8 PRIMARY KEY CHECK (year >= 2000),
  last_value INT8 NOT NULL CHECK (last_value > 0)
);
ALTER TABLE consents ADD COLUMN consent_code STRING UNIQUE CHECK (consent_code ~ '^CNS-[0-9]{4}-[0-9]{5}$');
ALTER TABLE consents ADD COLUMN text_version INT8 CHECK (text_version > 0);
ALTER TABLE consents ADD COLUMN sources STRING[] CHECK (cardinality(sources) > 0);
ALTER TABLE consents ADD COLUMN quote_ref STRING CHECK (quote_ref ~ '^COT-[0-9]{4}-[0-9]{5}$');
ALTER TABLE consents ADD COLUMN seal STRING CHECK (seal ~ '^[0-9a-f]{64}$');
ALTER TABLE consents ADD COLUMN idempotency_key STRING CHECK (length(idempotency_key) BETWEEN 1 AND 128);
ALTER TABLE consents ADD COLUMN request_hash STRING CHECK (request_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX consents_idempotency ON consents (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
