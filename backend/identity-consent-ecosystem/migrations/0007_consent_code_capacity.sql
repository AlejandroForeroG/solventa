ALTER TABLE consents ADD CONSTRAINT check_consent_code_capacity
  CHECK (consent_code ~ '^CNS-[0-9]{4}-[0-9]{5,19}$');
ALTER TABLE consents DROP CONSTRAINT check_consent_code;
