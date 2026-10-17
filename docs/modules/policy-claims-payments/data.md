# Contractual data, money and evidence

Policies preserve coverage and offer version. Money uses DECIMAL(19,4) and currency, never float. Unique keys limit duplicates; valid transitions and third-party reconciliation remain use-case responsibilities. Composite foreign keys keep indemnity, claim and payment within the same policy. Existing tables neither implement these operations nor establish PCI-DSS compliance.

`evidence_metadata` stores R2 key, size, checksum, state and retention. `verified` requires `verified_at`; application checks the object/checksum. SQL and R2 do not share a transaction.

See [permissions, events and SQL operations](../../infrastructure/data-model.md).

The [synthetic financial flow](README.md#transactions-and-recovery) stores accepted terms, their keyed digest, canonical document and decision capture in append-only `financial_contracts`. `policy_signatures` binds a synthetic receipt to that exact document fingerprint. `financial_commands` scopes request fingerprints and final results to actor and hashed idempotency key. A unique index over the accepted offer ID/revision prevents another Policy record for the same revision. No legacy row is backfilled into an assumed accepted offer.

`mock_gateway_operations` is the durable ledger of the explicitly synthetic external payment protocol. It records a unique payment intent, exact DECIMAL amount/currency, request hash and confirmation/refund. This permits reconciliation across service instances; it does not represent a real charge. Provider interaction remains outside the owner transaction committing business state/audit/outbox, so recovery must handle a provider confirmation followed by incomplete local issuance.

Append-only `financial_payment_intents` binds each `(policy_id, operation)` to its original payment ID, key and keyed fingerprint. The store resolves mutable payments through this reference, verifies matching metadata and rejects orphaned financial payment rows. Provider identities cannot be silently replaced by altering a mutable operation/key, and the fingerprint includes the provider operation identity rather than money alone.

Inbox `payload_hash` and `policy_id` are nullable for compatibility with older events. New financial consumers populate both and require an identical digest on replay. Inbox retains SELECT/INSERT only. Invalid stored terms or projections are not silently repaired: integrity failure blocks use and persists the minimal rejection in a separate transaction after the attempted business transaction rolls back.

## Financial decision history

Application constructs each [decision capture](../../endpoint-standards.md#historical-capture-of-each-decision) from the inputs actually used. The SQL adapter receives the complete capture and commits it in the same transaction as its business transition, audit and outbox; it does not infer inputs from later projections. Accepted-offer import stores the same capture in `financial_contracts.decision_capture` and its outbox event. Other financial decisions retain their capture in the owner's corresponding outbox payload, correlated with the audit. No new table, migration or public API is needed.

Every successful business capture preserves the safe accepted-offer snapshot: acceptance/offer IDs and revision, product, exact decimal premium/COP, coverage and validity/signing deadlines, acceptance time and source rule version. It also binds the immutable terms/document fingerprints, policy reference, evaluation timestamp and applied `academic-financial-1` rule. Client IDs, subject tokens, personal fields, credentials, raw caller idempotency keys and event/signature authentication values are excluded.

| Decision | Additional historical evidence |
|---|---|
| `offer.accepted` | Authenticated envelope ID/type/environment/occurrence and the actual synthetic Acquisition source observation. This imports accepted terms; it does not reconsult underwriting providers or assert current risk-data consent. |
| `premium.requested` | Original payment ID, stable internal intent key/fingerprint, exact amount/currency and pending state; sources remain empty before a provider is consulted. |
| `premium.confirmed` / `premium.declined` | The same intent and resulting state, plus the gateway lookup and settlement results actually observed. A lookup-based recovery records the lookup without inventing another settlement. |
| `premium.refund_requested` | Confirmed intent and the finite actual cause: signature refusal, invalid receipt, expiry before/after signing, or expiry in the final transaction. A signature source appears only when that provider was called. |
| `premium.refunded` | Refunded intent and the actual lookup/refund results. Recovery of an existing refund refers to the original policy/payment intent and decision history instead of inventing or recopying an unread original cause. |
| `policy.issued` | Confirmed premium intent, exact document fingerprint, persisted issuance timestamp and observed synthetic signature result. The signature row preserves the receipt; the capture references its policy/document/time without copying authentication material. |
| `parametric.accepted` | Authenticated event ID/type/environment/occurrence, observed delay, threshold/payout/flight reference in the immutable coverage, issuance/coverage window and pending indemnity intent. |
| `indemnity.confirmed` | The same covered occurrence and original intent, plus the actual gateway reconciliation/settlement result and confirmed state. |

Sources identify synthetic adapters, their locally observed `capturedAt`, operation, result and recognized mock provider reference. Unknown/unrecognized references are not copied as arbitrary provider text. These records explain the academic mocks; they do not establish a real provider timestamp, legal signature or settlement. A technical provider failure without a business result does not invent a successful source or decision. Rejections remain minimal fixed-cause records without copying unvalidated input.

This richer history applies to new decisions only. Existing captures are not rewritten or backfilled with missing information. Completed command/event replays retain their original capture and do not emit duplicate decisions. A later refund or mutable projection alteration does not change the saved amount, coverage, source result or rule of an earlier decision. The SQL suite validates the persisted JSON against the shared schema and exact business values, including refund recovery, replay, projection changes and transactional rollback; schema shape alone is insufficient.
