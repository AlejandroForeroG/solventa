-- Match keyset pagination so a growing history does not require sorting every consent for each page.
CREATE INDEX consents_by_client_grant ON consents (client_id, granted_at DESC, id)
  WHERE consent_code IS NOT NULL;
