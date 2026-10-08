-- The idempotency key belongs to the actor alone, so reusing it with another customer is a conflict, not a new quote.
CREATE UNIQUE INDEX quotes_partner_idempotency ON quotes (partner_id, idempotency_key) WHERE partner_id IS NOT NULL;
DROP INDEX quotes_user_idempotency;
CREATE UNIQUE INDEX quotes_user_idempotency ON quotes (client_id, idempotency_key) WHERE client_id IS NOT NULL;
