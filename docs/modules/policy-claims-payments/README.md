# Policy, Claims & Payments

Code: `backend/policy-claims-payments`. This module owns issuance, policies, premiums, payments, reconciliation, claims, evidence and indemnities. It receives Acquisition offer references; it maintains separate adapters for payments, signatures and other integrations it owns.

## Implemented state

Worker with its own `policy` schema, runtime role and Hyperdrive. `/health` indicates liveness. RPC diagnostics protected by web check its SQL store. Base tables exist; domain/application still have no business use cases. Issuance, financial operations, R2 upload and Workflows coordination require implementation.

## Documents

- [Contractual data, money and evidence](data.md).
- [Boundaries and communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
