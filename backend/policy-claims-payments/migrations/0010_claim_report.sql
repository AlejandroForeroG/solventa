-- Customer report of a claim: the draft keeps what the customer declared, and the number is assigned only when the report is submitted.
ALTER TABLE claims ADD COLUMN event_type STRING CHECK (event_type IS NULL OR event_type IN ('collision', 'theft', 'damage', 'other'));
ALTER TABLE claims ADD COLUMN event_place STRING CHECK (event_place IS NULL OR length(event_place) BETWEEN 1 AND 120);
ALTER TABLE claims ADD COLUMN description STRING CHECK (description IS NULL OR length(description) BETWEEN 40 AND 600);
ALTER TABLE claims ADD COLUMN submitted_at TIMESTAMPTZ;
-- The client names each file once, so a repeated manifest or upload resolves to the same row.
ALTER TABLE evidence_metadata ADD COLUMN client_file_id UUID;
CREATE UNIQUE INDEX evidence_by_client_file ON evidence_metadata (claim_id, client_file_id);
CREATE TABLE claim_number_counters (
  year INT4 PRIMARY KEY CHECK (year BETWEEN 2000 AND 9999),
  last_number INT4 NOT NULL CHECK (last_number BETWEEN 1 AND 99999),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
