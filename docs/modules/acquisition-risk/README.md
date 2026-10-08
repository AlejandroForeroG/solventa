# Acquisition & Risk

Code: `backend/acquisition-risk`. This module owns quotes, pricing, profiling, rating, underwriting, offers and asynchronous refresh of authorized signals. Issuance and collection belong to Policy; authorization and consent belong to Identity.

## Implemented state

Worker with its own `acquisition` schema, runtime role and Hyperdrive. `/health` indicates liveness. RPC diagnostics protected by web check SQL and communication with Identity. Base tables exist; domain/application still have no business use cases. Quoting, profiling, Open Finance, fallback and asynchronous refresh require implementation.

## Documents

- [Data, historical capture and offer revisions](data.md).
- [Contracts and decision capture](../../shared/contracts/README.md).
- [Boundaries and communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
