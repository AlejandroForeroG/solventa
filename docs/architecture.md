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

Acquisition and Policy cores still have no business use cases. The current foundation does not establish public business contracts, event publication/consumption, effective consent or complete financial flows.
