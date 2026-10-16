ALTER TABLE policy_signatures ADD COLUMN time_seal STRING CHECK (time_seal IS NULL OR time_seal ~ '^[0-9a-f]{64}$');
