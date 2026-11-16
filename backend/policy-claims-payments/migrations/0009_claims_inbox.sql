ALTER TABLE claims ADD COLUMN claim_number STRING CHECK (claim_number IS NULL OR claim_number ~ '^SIN-[0-9]{4}-[0-9]{5}$');
ALTER TABLE claims ADD COLUMN estimated_amount DECIMAL(19,4) CHECK (estimated_amount IS NULL OR estimated_amount >= 0);
ALTER TABLE claims ADD COLUMN currency STRING NOT NULL DEFAULT 'COP' CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE claims ADD COLUMN assignee_id UUID;
ALTER TABLE claims ADD COLUMN evidence_required INT4 NOT NULL DEFAULT 0 CHECK (evidence_required >= 0);
CREATE UNIQUE INDEX claims_claim_number_key ON claims (claim_number);
CREATE INDEX claims_open_by_age ON claims (created_at) WHERE status IN ('unassigned', 'in_review', 'pending_information', 'escalated');
