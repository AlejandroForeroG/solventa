# Solventa documentation

This directory contains the product's current technical documentation. Its organization follows the responsibilities in the architecture's functional view. Guides describe implemented behavior and identify pending capabilities. All product documentation and code identifiers use English; user communication remains in Spanish.

## System modules

| Module | Responsibility | Code |
|---|---|---|
| [Acquisition & Risk](modules/acquisition-risk/README.md) | Quotes, pricing, profiling, underwriting, offers and authorized signal refresh | `backend/acquisition-risk` |
| [Identity, Consent & Ecosystem](modules/identity-consent-ecosystem/README.md) | Identity, authorization, consent, devices and partners | `backend/identity-consent-ecosystem` |
| [Policy, Claims & Payments](modules/policy-claims-payments/README.md) | Issuance, policies, collection, reconciliation, claims, evidence and indemnities | `backend/policy-claims-payments` |

## Channels and shared components

| Guide | Code |
|---|---|
| [Web](channels/web/README.md) | `apps/web` |
| [Mobile](channels/mobile/README.md) | `apps/mobile` |
| [Contracts and API versioning](shared/contracts/README.md) | `packages/contracts` |
| [Brand and shared assets](shared/assets/README.md) | `packages/assets` |

## Cross-cutting guides

- [UI style and its sources](channels/ui-style.md).
- [Installation and development](development.md).
- [Architecture and boundaries](architecture.md).
- [Security controls, authorization matrix and data custody](security.md).
- [Endpoints and business decisions](endpoint-standards.md).
- [Purposeful testing](testing.md).
- [Change review and acceptance criteria](change-review.md).
- [Infrastructure operations](infrastructure/README.md).
- [Read-only SQL access](infrastructure/read-only-sql.md).
- [SQL model and permissions](infrastructure/data-model.md).
- [Creating, applying and recovering migrations](infrastructure/migrations.md).
- [CI/CD and environment promotion](infrastructure/ci-cd.md).

## Maintaining documentation

Mandatory rules are in [AGENTS.md](../AGENTS.md#required-documentation). Find the existing module and topic first; update its guide in the same branch and PR that changes behavior. Create a document only for a new topic, inside its module, and link it from the module index.

Each topic has one authoritative explanation. README files beside code link to these guides. Document shared changes once in their cross-cutting guide and link it from affected modules. Git preserves history: keep the current behavior, remove obsolete instructions and do not create copies per branch, feature, sprint or environment. Each PR links the guides it creates or updates on its source branch.

Historical underwriting lookup: [Acquisition audit API and workspace](modules/acquisition-risk/underwriting-audit.md).

Partner requests for a customer's offer: [Partner authorizations](modules/identity-consent-ecosystem/partner-authorizations.md) and [Acquisition partner offers](modules/acquisition-risk/README.md#partner-offers).

Operational claims list: [Claims inbox API and workspace](modules/policy-claims-payments/claims-inbox.md).
Customer policy portal (coverage, documents, payments): [Web policy portal](modules/policy-claims-payments/README.md#web-policy-portal).
