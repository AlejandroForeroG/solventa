# Base SQL model

Migrations implement architecture aggregates with UUIDs, timestamps, versions and local constraints. SQL names, types and initial states are implementation decisions for the conceptual model. Use cases enforce state transitions and per-user authorization; the financial increment runs only with explicit synthetic provider adapters outside production.

| Owner | Business tables |
|---|---|
| identity | clients, external_identities, authentication_sessions, partners, partner_credentials, consents, consent_counters, registered_devices |
| acquisition | quotes, quote_counters, risk_profiles, underwriting_decisions, offers, offer_revisions, signal_refresh_jobs, offer_contexts, offer_acceptances, offer_requests |
| policy | policies, claims, indemnities, payments, evidence_metadata, financial_contracts, financial_commands, policy_signatures, mock_gateway_operations, financial_payment_intents |

Each owner adds `audit_events`, `outbox_events` and `inbox_events`: 37 tables, plus three administrative `schema_migrations` ledgers and three migration-failure guards. An environment contains only migrations already applied there. No foreign keys cross schemas; external references are validated through a contract/event, never a query to another owner's tables.

## Data by module

- [Identity and consent](../modules/identity-consent-ecosystem/data.md).
- [Acquisition, risk and offer history](../modules/acquisition-risk/data.md).
- [Policies, money and evidence](../modules/policy-claims-payments/data.md).

## Events and permissions

Commit result, audit and outbox in one local transaction. Outbox maintains leases, attempts and availability; mark `published` only after confirming transport. Commit effect and inbox together; UNIQUE(event_id, consumer) deduplicates per consumer. Identity implements a scoped publisher for security-denial events with leases, bounded retries and dead-letter states; its optional email adapter confirms provider acceptance, not inbox delivery. See [security publication](../security.md#alert-publication-and-email-configuration). Acquisition publishes signed accepted offers to environment-specific Queues. Policy verifies and consumes accepted offers and synthetic parametric events through its inbox, persisting immutable financial terms, payment intents and signatures. Provider operations execute outside SQL transactions and reconcile on an explicit retry through the durable mock ledger. Automated background recovery and publication of Policy business notifications remain pending; the detailed behavior and limits belong to the owner guides above.

`runtime-grants.json` enumerates owned tables/privileges: no DELETE, DDL, cross-owner access or ledger writes. Audit and inbox are append-only for runtime. Retention/maintenance require an administrative operator. These permissions isolate backends; they do not replace user authorization or consent.

## Operations

Follow [creating, applying and recovering migrations](migrations.md) for new SQL, permissions, local tests, administrative application per environment and DDL/guard reconciliation. The procedure includes fresh installation/replay, checksums, non-atomic grants and Worker rollback compatibility. This model does not duplicate those instructions.

The current Basic cluster has one region; no high availability is claimed.
