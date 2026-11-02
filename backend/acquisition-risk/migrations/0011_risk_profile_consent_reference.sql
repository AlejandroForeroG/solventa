-- Identity exposes public consent codes (CNS-YYYY-N), while older profile rows used Identity's
-- internal UUID. Preserve those rows and let new snapshots store the opaque public reference.
ALTER TABLE risk_profiles ADD COLUMN consent_reference STRING;
ALTER TABLE risk_profiles ALTER COLUMN consent_id DROP NOT NULL;
ALTER TABLE risk_profiles ADD CONSTRAINT risk_profiles_one_consent_reference
  CHECK ((consent_id IS NULL) <> (consent_reference IS NULL));
ALTER TABLE risk_profiles ADD CONSTRAINT risk_profiles_consent_reference_format
  CHECK (consent_reference IS NULL OR consent_reference ~ '^CNS-[0-9]{4}-[0-9]{5,19}$');
