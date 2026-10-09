# Native authentication

Native clients authenticate with WorkOS AuthKit using authorization code + PKCE, store their tokens on the device and send the **user access token** as `Authorization: Bearer <token>` to Solventa's public gateway. Identity owns verification, local registration, permission decisions and revocation. The gateway forwards to its private Identity binding with the existing five-second API deadline and version gate. See the [OpenAPI contract](../../../packages/contracts/openapi/v1/mobile-authentication.yaml), [mobile integration guide](../../channels/mobile/README.md#connecting-native-login) and [Bruno requests](../../../tools/bruno/solventa/README.md).

## Routes

All paths below include `/api/v1`. Responses have a correlation UUID in `X-Trace-Id` and `traceId`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Route | Method | Behavior |
|---|---|---|
| `/mobile/config` | GET | Public client ID, fixed callback `solventa://auth/callback`, WorkOS authorization/token endpoints |
| `/mobile/session` | POST | Verify the user token and register the local client/session; active retries return the same principal |
| `/mobile/session` | GET | Verify the user token and inspect the existing active local session |
| `/mobile/session` | DELETE | Revoke locally, then at WorkOS; return `status: signed_out` after both steps |
| `/access/mobile` | GET | Verify the token and active local session, then return the native user actor for `quotes:create` |

POST and DELETE need no body. Identity derives the principal from verified claims; a supplied client ID has no effect. Protected native routes reject any Cookie header with 400. They never interpret sealed web cookies, partner M2M tokens, server API keys or `subjectToken` as native credentials. Unsupported methods return 405 with Allow. Missing, malformed, foreign or expired tokens and unavailable local sessions return 401 with a Bearer challenge. Missing configuration or unavailable dependencies return 503; permission policy denials return 403.

## Verification and persistence

The outbound adapter uses the environment's WorkOS client-specific JWKS, RS256, exact issuer `https://api.workos.com/user_management/<clientId>`, matching `client_id`, user `sub`, session `sid` and valid integer `iat`/`exp`. An audience, when present, must match the client. Impersonation tokens are denied. Provider `getUser` checks that the current user exists and has a verified email. Only provider public keys are cached; account/session authorization is never cached. WorkOS calls have explicit timeouts and no SDK retries.

Registration reuses the [existing identity store](authentication.md). Client, provider mapping, session, audit and first-client outbox commit in the owner's transaction. Active registration retries do not duplicate audit/outbox or extend expiry. Conflicting first registrations resolve through the unique mapping and one bounded lookup/retry; a serialization rejection retries only after confirmed rollback, never after an uncertain commit. Expired or revoked session references cannot be reopened; a suspended client cannot register. Maximum local session duration remains seven days. GET and access checks never register, refresh or extend a session. No schema changes are required.

Every use requires a current signed token and active local session belonging to that provider user. The access actor has `kind: user`, `channel: mobile`, a pseudonymous principal and `operations: [quotes:create]`. This is a permission probe, not a native quote endpoint. The private authorization RPC also accepts `{kind:'mobile', token, operation:'quotes:create'}`; native consent operations are denied. Existing quote/consent HTTP adapters retain their own channel contracts and must be extended deliberately before native business calls.

Logout ensures the verified session has a local record, then revokes SQL first. This also blocks a pending first bootstrap from registering after logout. If WorkOS revocation fails, HTTP returns 503 while the local session remains unusable; a bounded retry with a still-valid access token can finish provider revocation. An already missing provider session is a safe retry. Offline device logout cannot revoke remotely until connectivity returns; do not report server revocation from a local token deletion. External WorkOS revocation is reflected on access-token expiry/refresh: no revocation-event consumer or per-request session introspection exists. `getUser` verifies account state, not provider session state.

## WorkOS configuration

Reuse the environment's existing `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` in Identity; no new server secret goes to the app. Each local/dev/staging/prod WorkOS environment must register the exact additional Redirect URI `solventa://auth/callback`, preserving its web callback. Enable public native authentication with PKCE according to [WorkOS's Expo example](https://github.com/workos/expo-authkit-example). Mobile never needs `WORKOS_API_KEY`, `AUTH_COOKIE_PASSWORD`, consent sealing keys, the infrastructure token or a partner secret. Keep the existing provider and branding choices.

GET `/mobile/config` reports the backend's public configuration; it does not establish that the callback is registered at WorkOS. Operators must separately verify the allowed redirect and a browser login/code exchange. Do not substitute one environment's client/token for another's. The [channel guide](../../channels/mobile/README.md) lists the public bases and implementation steps.

## Validation and limits

`npm run test:authentication` covers JWT isolation, signature/time failures, verified/deleted users, local session policy, HTTP lifecycle and fail-closed provider errors. `npm run test:contracts` validates actual HTTP bodies/statuses against OpenAPI. `npm run test:authentication:sql` verifies real local registration, active replay, concurrency, suspension, expiry and revocation in a disposable database. Bruno provides reproducible native requests using a user token held only as a local secret variable.

Backend authenticated HTTP verification is separate from native browser/deep-link validation. The Expo app currently has its welcome route; its login UI, secure token storage, callback state verification and refresh must be implemented in that channel. This connection adds no biometrics, device registration/attestation, consent onboarding, policy purchase or claims flow. A verified WorkOS session does not prove the customer's biometric identity or consent.
