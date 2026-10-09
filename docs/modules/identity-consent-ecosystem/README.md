# Identity, Consent & Ecosystem

Code: `backend/identity-consent-ecosystem`. This module is the authority for identity, authorization, consent, devices and partner access. Actuarial and financial decisions belong to other modules.

## Documents

- [Web authentication: routes, session, configuration and tests](authentication.md).
- [API access: M2M partners, web users, contract and Bruno](api-access.md).
- [Identity, consent and device data](data.md).
- [Consent: terms, rules, fresh access check and failures](consent.md).
- [Boundaries and backend communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

Web authentication and `quotes:create` access probes for M2M partners and authenticated web users are implemented. M2M access requires WorkOS setup and configuration per environment. The consent record is implemented ([consent](consent.md)): terms, grant, decline, panel list, revocation and the fresh check other modules call before using a source; no source is queried yet. Quoting, quotas, other business permissions, biometrics and mobile login still require their use cases and validation. Existing tables do not establish those flows.

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
