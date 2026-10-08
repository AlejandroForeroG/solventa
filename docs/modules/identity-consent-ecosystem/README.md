# Identity, Consent & Ecosystem

Code: `backend/identity-consent-ecosystem`. This module is the authority for identity, authorization, consent, devices and partner access. Actuarial and financial decisions belong to other modules.

## Documents

- [Web authentication: routes, session, configuration and tests](authentication.md).
- [Identity, consent and device data](data.md).
- [Boundaries and backend communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

Web authentication is implemented. Effective consent, business permissions, quotas, partner authentication, biometrics and mobile login require their use cases and validation. Existing tables do not establish those flows.

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
