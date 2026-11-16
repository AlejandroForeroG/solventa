# Partner authorizations

A distribution partner can request a profiled mortgage life offer for a customer only if that customer, signed in on the web, authorized that partner for that operation. Identity owns the authorization, the partner identity and the customer's consent; [Acquisition](../acquisition-risk/README.md#partner-offers) prices the offer. The public contracts are [partner-authorizations.yaml](../../../packages/contracts/openapi/v1/partner-authorizations.yaml) and [partner-offers.yaml](../../../packages/contracts/openapi/v1/partner-offers.yaml), with the synthetic corpus in [partner-offers.json](../../../packages/contracts/examples/partner-offers.json).

Three permissions must all hold on every request, and none replaces another:

| Permission | Who grants it | Where it is checked |
|---|---|---|
| The partner's identity and its `partner-offers:create` scope | The operator registers the credential; WorkOS issues the token | Signature, issuer, audience, claims and scopes of the M2M token, intersected with the local credential ([API access](api-access.md)) |
| An authorization for this partner and operation | The customer, from an authenticated web session | `partner_authorizations`, resolved for the exact partner |
| Consent to use the customer's data | The customer ([consent](consent.md)) | Fresh read of the four `risk_profiling` scopes for the customer behind the authorization |

A partner token, an advisor role, a customer identifier or document in the body, or a consent kept in a browser never replaces any of them.

## Customer routes

All routes require the sealed web session cookie and, for writes, the allowed `Origin`; an `Authorization` header is rejected with 400. The customer comes only from the session. The body is limited to 4096 bytes.

| Route | Operation | Effect |
|---|---|---|
| `POST /api/v1/me/partner-authorizations` | `partner-authorizations:write` | Body `{ partnerCode, validityDays? }`: `partnerCode` of an active partner, `validityDays` 1 to 90 (30 by default). Creates a distinct authorization (201). An unknown or inactive partner is 404 `partner_not_found`. Unknown properties are 400 |
| `GET /api/v1/me/partner-authorizations` | `partner-authorizations:read` | The customer's own authorizations, newest first, at most 50, with status `active`, `revoked` or `expired` computed on every read |
| `POST /api/v1/me/partner-authorizations/{authorizationId}/revoke` | `partner-authorizations:write` | Revokes an own authorization on the partner's next request. Revoking twice returns the same record; an expired authorization is 409 `authorization_not_active`; a foreign or unknown id is an opaque 404 |

Only a web customer holds the two `partner-authorizations:*` operations. Partners and native sessions are denied, and `partner-offers:create` is a partner-only operation that no web or native session holds. The authorization id is the only thing the customer hands to the partner, outside Solventa; it identifies no one by itself. The grant, and a first revocation, commit the row, the audit event and the outbox event in one transaction, so a failed record leaves no authorization.

## Private access check for Acquisition

`authorizePartnerOfferAccessV1` is a private Service Binding RPC, not a public route. Input: `{ token, authorizationId, traceId }`; the authorization must be a UUID, otherwise 400 before any authentication. It is one remote call that encloses, in this order:

1. The partner's authentication and operation policy for `partner-offers:create`. A token with `quotes:create` only is `403 forbidden`; a missing or invalid token is `401`.
2. The lookup of the authorization for that partner: it must exist, belong to that partner, not be revoked or expired, and its customer and partner must be active. Unknown, foreign, revoked and expired authorizations are the same `403 forbidden`, so a partner cannot learn whether an id exists. The denial is recorded as a minimal security decision (`channel: partner`, `operation: partner-offers:create`).
3. A fresh read of the four `risk_profiling` scopes for that customer in one batch, requiring one current sealed consent that covers all of them. Missing, revoked, expired, mixed or altered consent is `403 consent_required`, recorded the same way.

The positive answer is `{ allowed: true, partnerId, customer: { clientId, subjectToken }, authorizationExpiresAt, consent: { consentId, textVersion, expiresAt } }`. A technical failure at any step, a failed denial record or an inconsistent actor is `503 access_unavailable`: the protected use is blocked, never relaxed. Nothing is cached between requests, so a revocation of the authorization or of the consent takes effect on the next call, including a retry of an earlier order. This is not a transaction across Identity and Acquisition and does not promise atomicity against a concurrent revocation.

## Operator registration

The partner's registration must carry the `partner-offers:create` scope in addition to `quotes:create`, and the WorkOS M2M application must have the scope enabled, as in [API access](api-access.md#registering-and-revoking-partner-access). The operator accepts `["quotes:create"]` or `["quotes:create", "partner-offers:create"]`.

## Persistence

Migration `0013_partner_authorizations.sql` adds Identity's `partner_authorizations` (partner and client foreign keys, one operation limited to `partner-offers:create`, grant, expiry and optional revocation timestamps). Expiry is mandatory and at most 90 days from the grant. Runtime can SELECT, INSERT and UPDATE; it cannot DELETE. Apply it through the [migration guide](../../infrastructure/migrations.md) before deploying the code that uses it.

## Verification and limits

- `npm run test:consents` covers the customer routes, the operation policy and the access check with in-memory ports. `npm run test:partner-authorizations:sql` runs the real SQL adapter with the runtime role: atomic audit and outbox, exact-partner lookup, ownership, idempotent revocation, expiry, inactive partner or customer, schema bounds and no runtime delete.
- `npm run test:quotes` includes the partner journey with the real gateway, Identity and Acquisition use cases. See [Acquisition](../acquisition-risk/README.md#partner-offers) for what is real, in memory and mocked.
- The customer has no screen for these authorizations yet: only the API exists, and the partner portal that would show them is a separate story.
- A real partner is not onboarded by this feature: the operator registration, the WorkOS scope and the customer authorization must each exist in the target environment, and none was exercised against a real WorkOS issuer.
