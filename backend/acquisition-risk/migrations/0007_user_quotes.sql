-- A quote is created either by a partner (partner_id) or by an authenticated web user (client_id).
-- Expand step: existing rows keep their partner and satisfy the new constraint.
ALTER TABLE quotes ALTER COLUMN partner_id DROP NOT NULL;
ALTER TABLE quotes ADD COLUMN client_id UUID;
CREATE UNIQUE INDEX quotes_user_idempotency ON quotes (client_id, subject_token, idempotency_key) WHERE client_id IS NOT NULL;
ALTER TABLE quotes ADD CONSTRAINT quotes_one_actor CHECK ((partner_id IS NULL) <> (client_id IS NULL));
