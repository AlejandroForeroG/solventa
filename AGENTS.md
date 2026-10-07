# Working in Solventa

## Communication and scope

- Respond to the user in Spanish. Keep these instructions in English; preserve the established language of each document and codebase.
- Read the complete task, acceptance criteria, relevant architecture sources and UI references before editing. Inspect the existing implementation and [documentation index](docs/README.md); do not infer that a provisioned service or table implements a feature.
- Check the current branch, worktree and working tree before changing files. Preserve other contributors' work. Keep changes within the requested scope; do not bundle unrelated refactors or dependency upgrades.
- Resolve routine implementation choices independently. Explain missing sources or contradictions that affect correctness, and ask only when the answer is needed to proceed. Do not invent requirements or implementation evidence.

## Architecture and integration

- The authoritative source is the [Solventa architecture document](https://docs.google.com/document/d/19xO1-UH7n3q_vsnDWfzJcDXH49-eQEDGCeWIDw4gQFU/edit). Read it completely before changing responsibilities, boundaries or integrations. In the primary workspace, its local copy is `../output/semana8-arquitectura.pdf`, with supporting changes in `../docs/semana-7/04-ajustes-arquitectura.md`. These belong to the parent repository; they are absent from a standalone clone and may not resolve from a worktree. Locate the parent source or use the document; report unavailable sources rather than replacing them with assumptions.
- Keep the monorepo and three independent backends: [Acquisition & Risk](docs/modulos/acquisition-risk/README.md), [Identity, Consent & Ecosystem](docs/modulos/identity-consent-ecosystem/README.md), and [Policy, Claims & Payments](docs/modulos/policy-claims-payments/README.md). Channels are `apps/web` (React/Vite) and `apps/mobile` (Expo/React Native).
- Follow [hexagonal boundaries](docs/arquitectura.md): Domain owns business rules; Application coordinates use cases through ports; adapters handle HTTP, SQL, providers and messaging. Domain and Application must not import infrastructure SDKs or platform types. Use dependency injection at the composition root; introduce abstractions only for a concrete need.
- Each backend owns its entities, repositories, SQL schema, runtime role and transactions. Never read another owner's tables. Collaborate through contracts or events; `packages/contracts` contains boundary contracts, not shared domain entities or repositories.
- Trace the full connection before changing an interface: caller, public route, adapter, use case, persistence, provider or consumer, and response. Update affected callers, contracts, configuration and tests together. Keep API changes compatible or introduce a new version according to the [contract guide](docs/compartidos/contracts/README.md).
- Keep at most one internal remote dependency in the critical business path. Await Service Binding calls and use explicit deadlines and errors. Do not expand a diagnostic RPC into an undocumented business API.
- Async delivery is at least once. Implement outbox/inbox, stable event IDs, bounded retries and observable failures with their use cases. Commit the consumer effect and inbox before ACK. Do not claim distributed atomicity between Workers, SQL and R2, or exactly-once transport.

## Code quality and failure handling

- Prefer the smallest coherent change. Reuse existing capabilities, keep functions focused and names explicit, and remove obsolete branches introduced by the change. Avoid speculative frameworks, duplicated logic and abstractions that merely rename another layer.
- Be critical of your own code. Read the final diff as a reviewer: challenge assumptions, check invariants and follow every changed failure path. Passing tests does not establish correct ownership, security or integration.
- Add comments only when they explain a non-obvious reason, invariant or external constraint. Do not narrate obvious code, add decorative section comments, leave stale explanations, or suppress type/lint errors without a specific justification.
- Validate untrusted input at boundaries, including missing fields, nulls, formats, lengths and unexpected values. Preserve precise types; do not use casts or `any` to hide contract mismatches. Treat provider payloads as untrusted and translate them in adapters.
- Check relevant edge cases: empty data, invalid or expired sessions, revoked consent, unauthorized access, duplicate requests/events, concurrent writes, stale results, timeouts, unavailable dependencies and partial completion. Choose cases from the actual flow, not a generic test checklist.
- Do not swallow errors or return success after a failed write. Distinguish invalid input, access denial, conflict and technical failure; preserve useful causes without exposing secrets or PII. Authorization or consent verification failure must block protected use.
- Retry only eligible operations, within the original deadline and with bounded attempts. Cancel or close the prior attempt. Financial or external effects need stable idempotency keys and reconciliation after uncertain outcomes; a retry must not repeat a charge or payment.
- Keep business writes, audit and outbox in the owner's transaction when required. Handle races and uniqueness conflicts explicitly; a unique idempotency key alone does not reject reuse with a different payload. Keep money in the established decimal representation and use explicit units, currencies and time zones.

## Security and database access

- Verify authentication, authorization and applicable consent on the server. A valid session is not a business permission or consent. Follow the [authentication contract and limits](docs/modulos/identity-consent-ecosystem/autenticacion.md); keep WorkOS in Identity adapters and tokens out of client storage, SQL and logs.
- Use synthetic data for tests. Never commit or print credentials, tokens, PII or ignored secret files. Keep local, dev, staging and prod configuration and resources separate; never substitute one environment's credentials for another's.
- For inspection, follow [read-only SQL access](docs/infraestructura/consultas-sql.md): select an explicit environment and owner, use its runtime role, verified TLS and a READ ONLY transaction. Query only needed fields with filters and limits. Do not use the administrative URL for routine inspection or broaden grants to cross schemas.
- Runtime grants and migration guard restrictions are described in the [SQL model](docs/infraestructura/modelo-datos.md). Missing credentials require restoration from custody, not invented passwords or automatic rotation. Inspection does not authorize writes, provisioning or migrations.
- Never edit an applied migration. Add a new migration, preserve data and checksums, and follow the [operational recovery procedure](docs/infraestructura/README.md). CockroachDB DDL and grants may survive rollback; do not replay a failed migration or clear its guard without administrative reconciliation. CD must not receive administrative SQL credentials.

## UI style and behavior

- Consult [UI style sources](docs/canales/estilo-ui.md) before editing an interface. It points to the approved web/mobile mockups, shared brand source, web CSS, mobile theme and WorkOS branding guide. Respect the reference for the requested channel and flow; do not invent a parallel visual system.
- Reuse existing tokens, components and `@solventa/assets/web` or `@solventa/assets/mobile` resources. Follow [web](docs/canales/web/README.md), [mobile](docs/canales/mobile/README.md) and the mobile-specific [AGENTS.md](apps/mobile/AGENTS.md) where applicable.
- Keep UI copy minimal and functional: actions, states, errors and decisions. Do not add slogans, decorative descriptions or internal implementation details. Check applicable loading, empty, failure, access-denied and degraded states, accessibility and responsive behavior.
- UI simulations do not establish security or business behavior. A preliminary offer cannot enable contracting. Native biometric, permission and storage changes require a real native check; a build/export or device row is insufficient.

## Required documentation

- Every feature must include current technical documentation in `docs/` in the same branch and PR as its implementation. Fixes and refactors that change documented behavior, contracts, configuration or operation must update the affected guide before integration.
- Search the [index](docs/README.md) and existing module/topic first. Update the existing document; create one only for a new topic and link it from the module index.
- Follow the architecture modules under `docs/modulos/acquisition-risk`, `docs/modulos/identity-consent-ecosystem` and `docs/modulos/policy-claims-payments`. Put channel guides in `docs/canales`, contracts/assets in `docs/compartidos`, and cross-cutting operation in `docs/infraestructura`.
- Keep one authoritative explanation per topic. Link shared rules and procedures instead of copying them across modules. README files beside code are entry points. Do not create parallel documentation per branch, feature, sprint or environment; Git preserves history.
- Each branch changing a documented topic must describe the final behavior and relevant contracts, setup, commands, data/migrations, errors, verification and limits. Remove obsolete instructions and check links after moving or renaming files.
- State which documents changed in the PR. If an internal fix changes no documented behavior, explain that in the PR; this exception does not waive documentation for a feature.
- Keep product documentation technical, sober and monochrome. Planning, Jira references, academic sources, conversations and internal evidence stay in the parent repository, outside the product.

## Verification and delivery

- Test the behavior at the layer that owns it. Include relevant failure, boundary and integration cases; avoid tests that simply mirror implementation or unrelated test expansion. For code changes, run `npm run check` and the affected flow's tests. Use the [operational guide](docs/infraestructura/README.md) for infrastructure changes; validate documentation links for documentation changes.
- Review the actual UI flow against its reference and acceptance criteria. Distinguish local checks, CI, deployment smoke, complete user flows and native validation; report only what was executed.
- Use `feat/<description>`, `fix/<description>`, `refactor/<description>` or `test/<description>` branches from dev, in lowercase with hyphens and at most 72 characters. Do not require a ticket number or use `codex/`. Commits and PR titles follow `feat|fix|refactor|test(module): description`, at most 150 characters in the first line.
- Integrate through PRs: working branch → dev → staging → prod. Never push directly to environment branches. Require all CI checks; dev needs no human approval, staging/prod normally require one. An explicit user-authorized exception applies only to the requested promotion; preserve CI and restore any temporarily changed approval requirement.
- Follow [CI/CD](docs/infraestructura/ci-cd.md): confirm successful upstream deployment before promotion, retain the candidate tree and use normal merges between environments. Synchronize environment merge history back into dev through a working branch and PR when needed. Provision required resources and apply approved migrations before code that depends on them.
- Before closing, check the diff, working tree, acceptance criteria, documentation and actual CI/deployment results. Report the outcome in Spanish, including meaningful limits or unfinished validation. Never present scaffolding, mocks or infrastructure as completed business functionality.
