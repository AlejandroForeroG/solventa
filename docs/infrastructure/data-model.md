# Base SQL model

Migrations implement architecture aggregates with UUIDs, timestamps, versions and local constraints. SQL names, types and initial states are implementation decisions for the conceptual model. State machines and per-user authorization are completed in use cases.

| Owner | Business tables |
|---|---|
| identity | clients, external_identities, authentication_sessions, partners, partner_credentials, consents, consent_counters, registered_devices |
| acquisition | quotes, quote_counters, risk_profiles, underwriting_decisions, offers, offer_revisions, signal_refresh_jobs |
| policy | policies, claims, indemnities, payments, evidence_metadata |

Each owner adds `audit_events`, `outbox_events` and `inbox_events`: 29 tables, plus three administrative `schema_migrations` ledgers. No foreign keys cross schemas; external references are validated through a contract/event, never a query to another owner's tables.

## Data by module

- [Identity and consent](../modules/identity-consent-ecosystem/data.md).
- [Acquisition, risk and offer history](../modules/acquisition-risk/data.md).
- [Policies, money and evidence](../modules/policy-claims-payments/data.md).

## Events and permissions

Commit result, audit and outbox in one local transaction. Outbox maintains leases, attempts and availability; mark `published` only after confirming transport. Commit effect and inbox together; UNIQUE(event_id, consumer) deduplicates per consumer. Handlers, Queues, retries, DLQ and reconciliation still require implementation.

`runtime-grants.json` enumerates owned tables/privileges: no DELETE, DDL, cross-owner access or ledger writes. Audit and inbox are append-only for runtime. Retention/maintenance require an administrative operator. These permissions isolate backends; they do not replace user authorization or consent.

## Operations

Follow [creating, applying and recovering migrations](migrations.md) for new SQL, permissions, local tests, administrative application per environment and DDL/guard reconciliation. The procedure includes fresh installation/replay, checksums, non-atomic grants and Worker rollback compatibility. This model does not duplicate those instructions.

The current Basic cluster has one region; no high availability is claimed.
