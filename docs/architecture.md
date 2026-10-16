# Backend boundaries

Each backend is a deployment unit with its own migrations, SQL schema and runtime credential. Acquisition uses a Service Binding to Identity. The web Worker routes `/auth/*` through the Identity binding and composes operational checks through RPC to all three services. These diagnostic calls are not business contracts.

`src/index.ts` is the Cloudflare composition root. `adapters/inbound/http.ts` contains Hono and liveness; Identity also mounts authentication routes there. `adapters/outbound/database-probe.ts` contains PostgreSQL and storage diagnostics. Operational probes are not business use cases; do not wrap them in artificial interfaces to imply domain behavior.

When implementing a capability:

- `domain` contains its own rules and types, without SDKs, networking, environment variables or platform APIs.
- `application` coordinates the use case and defines its required ports. It may depend on its domain and application, never adapters.
- `adapters` implement ports; Hono, PostgreSQL, providers and Cloudflare stay here or in the composition root.
- The composition root injects adapters. A transaction belongs to one owner. Collaboration between owners uses contracts; future events require idempotency and a transactional strategy before enabling writes.
- New endpoints follow the [dependency, historical capture and routing standard](endpoint-standards.md), with injected HTTP factories, real adapters in the composition root and in-memory tests. Do not refactor authentication when adding business routes.
- Public routes live under `/api/v<N>/`; the web Worker applies version gating for deprecation and retirement, so backends do not repeat it. See [contracts](shared/contracts/README.md).
- `packages/contracts` contains only stable boundary contracts. Do not add shared entities, services or repositories to bypass separation.

`architecture:check` analyzes imports, exports, type imports and dynamic imports. It rejects core dependencies on SDKs/adapters, domain dependencies on application, and relative imports outside the backend. It compiles the core with ES2022 without Node, DOM or Workers types. `test:architecture` checks violation examples. This is a static aid; review must check semantic responsibilities and dependencies.

Identity implements web authentication use cases through session and persistence ports, with WorkOS and SQL adapters; see [authentication](modules/identity-consent-ecosystem/authentication.md). Client registration commits the identity link, session, audit and creation event in one transaction; local revocation commits state and audit together.

Acquisition implements the minimum-data quote through its own domain, application ports and adapters; quote, decision capture, audit and outbox are committed together. Identity also implements consent registration, listing, revocation and fresh verification, alongside native session registration and revocation. See the [Acquisition guide](modules/acquisition-risk/README.md), [consent guide](modules/identity-consent-ecosystem/consent.md) and [native session contract](modules/identity-consent-ecosystem/mobile-authentication.md).

The signal-reading use case checks consent before reaching its provider or stored copy. Its providers are simulated adapters selected by configuration, and no public profiling route calls it yet. The separate academic financial flow implements definitive offer acceptance, durable outbox publication through Cloudflare Queue, Policy inbox import, mock premium settlement/signature, issuance and synthetic parametric indemnity. Each owner keeps its SQL, audit and transaction; the real Queue transport does not provide distributed atomicity. Mock financial providers do not establish external settlement or legal signature validity. Customer notification delivery, autonomous issuance reconciliation and native biometric validation remain pending.

## External integrations

Each external party is reached or received through an adapter that translates its format and failures; the core only sees internal models and normalized errors. Replacing a provider changes an adapter and configuration, never the domain, use cases or ports. This holds in both directions: requests Solventa sends to providers (outbound adapters) and messages partners send to Solventa (inbound adapters). Industry-standard messages, such as ACORD, are translated at that same edge. Provider data, partner messages and industry-standard formats also have a versioned schema or format version and an agreed corpus that runs in CI; see [integration schemas and corpus](shared/contracts/README.md#integration-schemas-and-corpus).

| Integration | Direction | Current state |
|---|---|---|
| Signal sources: Open Finance, credit bureau, health affiliation, identity registry | Solventa queries | Two simulated adapters behind `SignalProvider`, in every environment; see [Acquisition](modules/acquisition-risk/README.md#signal-providers) |
| Distribution partners in ACORD Life inspired format | Partner sends a quote request, Solventa answers | Translator to and from the quote model, not mounted on a route; see [Acquisition](modules/acquisition-risk/README.md#acord-life-inspired-quote-messages) |
| Authentication and partner tokens (WorkOS) | Solventa queries | Implemented in Identity adapters (`workos-*.ts`); see [authentication](modules/identity-consent-ecosystem/authentication.md) and [API access](modules/identity-consent-ecosystem/api-access.md) |
| Identity verification (KYC) | Solventa queries | Partly covered: the `identity_validation` signal checks only that the document is valid. Biometric matching and AML/sanctions lists are not implemented; no separate port |
| Public statistics (DANE) | Solventa queries | Not implemented; aggregated data outside the consent and outside the signal scopes |
| Reinsurers, ACORD cession and portfolio reports | Solventa sends, reinsurer confirms | Not implemented; needs Policy's issued policies |
| Payment gateways | Solventa requests, gateway notifies | Policy has a durable synthetic gateway adapter for premiums, refunds and indemnities; real provider callbacks/settlement are not implemented |
| Electronic signature and notification | Solventa requests, provider notifies | Policy implements a deterministic synthetic signature adapter bound to the reviewed document; real signature and customer business-notification delivery are pending |
| Telemetry and parametric events | Provider sends events | Versioned signed synthetic flight-delay envelopes reach Policy through its private Queue consumer; no real oracle integration or public event route |

An integration that is not implemented has no port or adapter yet: create them with the first use case that needs it, in the module that owns that capability, following the same rule and adding its schema and corpus.
