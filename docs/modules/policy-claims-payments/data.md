# Contractual data, money and evidence

Policies preserve coverage and offer version. Money uses DECIMAL(19,4) and currency, never float. Unique keys limit duplicates; valid transitions and third-party reconciliation remain use-case responsibilities. Composite foreign keys keep indemnity, claim and payment within the same policy. Existing tables neither implement these operations nor establish PCI-DSS compliance.

`evidence_metadata` stores R2 key, size, checksum, state and retention. `verified` requires `verified_at`; application checks the object/checksum. SQL and R2 do not share a transaction.

See [permissions, events and SQL operations](../../infrastructure/data-model.md).
