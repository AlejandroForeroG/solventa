# Identity, Consent & Ecosystem

Code: `backend/identity-consent-ecosystem`. This module is the authority for identity, authorization, consent, devices and partner access. Actuarial and financial decisions belong to other modules.

## Documents

- [Web authentication: routes, session, configuration and tests](authentication.md).
- [Native authentication: user tokens, registration, revocation and connection](mobile-authentication.md).
- [Identity verification: native consent, synthetic evaluation, persisted progress and assisted requests](identity-verification.md).
- [API access: M2M partners, web users, contract and Bruno](api-access.md).
- [Identity, consent and device data](data.md).
- [Consent: terms, rules, fresh access check and failures](consent.md).
- [Boundaries and backend communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).
- [Security matrix, rejection records and optional email delivery](../../security.md).

Web authentication, native session/device lifecycle and `quotes:create` access probes for M2M partners, web and native users are implemented in the backend. Native platform evidence and server device registration are separate checks. M2M access and native callback registration require WorkOS setup per environment. The consent record is implemented ([consent](consent.md)): terms, grant, decline, panel list, revocation and the fresh check other modules call before using a source; no source is queried yet. Native business routes, quotas and other permissions remain separate use cases. Device rows do not attest biometric execution.

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.

Covered access and fresh-consent denials persist a minimal audit/outbox decision before responding. The security publisher claims only this module's denial events and can use native email delivery when explicitly configured. Email remains disabled by default; environment/provider setup, actual reception and latency evidence are separate from code and local tests. Financial tampering and business event consumers remain outside this implementation.
