# Identity, Consent & Ecosystem

Code: `backend/identity-consent-ecosystem`. This module is the authority for identity, authorization, consent, devices and partner access. Actuarial and financial decisions belong to other modules.

## Documents

- [Web authentication: routes, session, configuration and tests](authentication.md).
- [Native authentication: user tokens, registration, revocation and connection](mobile-authentication.md).
- [API access: M2M partners, web users, contract and Bruno](api-access.md).
- [Identity, consent and device data](data.md).
- [Consent: terms, rules, fresh access check and failures](consent.md).
- [Boundaries and backend communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

Web authentication, native session connection and `quotes:create` access probes for M2M partners, web and native users are implemented in the backend. M2M access and native callback registration require WorkOS setup per environment. The consent record is implemented ([consent](consent.md)): terms, grant, decline, panel list, revocation and the fresh check other modules call before using a source; no source is queried yet. Native login UI/storage/deep-link validation, native business routes, quotas, other permissions and biometrics still require their use cases and validation. Existing tables do not establish those flows.

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
