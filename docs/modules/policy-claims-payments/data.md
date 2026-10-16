# Contractual data, money and evidence

Policies preserve coverage and offer version. Money uses DECIMAL(19,4) and currency, never float. Unique keys limit duplicates; valid transitions and third-party reconciliation remain use-case responsibilities. Composite foreign keys keep indemnity, claim and payment within the same policy. Existing tables neither implement these operations nor establish PCI-DSS compliance.

`evidence_metadata` stores R2 key, size, checksum, state and retention. `verified` requires `verified_at`; application checks the object/checksum. SQL and R2 do not share a transaction.

See [permissions, events and SQL operations](../../infrastructure/data-model.md).

The [synthetic financial flow](README.md#transactions-and-recovery) stores accepted terms, their keyed digest, canonical document and decision capture in append-only `financial_contracts`. `policy_signatures` binds a synthetic receipt to that exact document fingerprint. `financial_commands` scopes request fingerprints and final results to actor and hashed idempotency key. A unique index over the accepted offer ID/revision prevents another Policy record for the same revision. No legacy row is backfilled into an assumed accepted offer.

`mock_gateway_operations` is the durable ledger of the explicitly synthetic external payment protocol. It records a unique payment intent, exact DECIMAL amount/currency, request hash and confirmation/refund. This permits reconciliation across service instances; it does not represent a real charge. Provider interaction remains outside the owner transaction committing business state/audit/outbox, so recovery must handle a provider confirmation followed by incomplete local issuance.

Append-only `financial_payment_intents` binds each `(policy_id, operation)` to its original payment ID, key and keyed fingerprint. The store resolves mutable payments through this reference, verifies matching metadata and rejects orphaned financial payment rows. Provider identities cannot be silently replaced by altering a mutable operation/key, and the fingerprint includes the provider operation identity rather than money alone.

Inbox `payload_hash` and `policy_id` are nullable for compatibility with older events. New financial consumers populate both and require an identical digest on replay. Inbox retains SELECT/INSERT only. Invalid stored terms or projections are not silently repaired: integrity failure blocks use and persists the minimal rejection in a separate transaction after the attempted business transaction rolls back.
