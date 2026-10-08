# API access

Identity verifies authentication and the `quotes:create` permission for partners and the web channel. The endpoints in this guide are access probes: they return the authorized actor without creating quotes or querying signals or consent. The public contract is in [OpenAPI](../../../packages/contracts/openapi/v1/identity-access.yaml), and reproducible requests are in [Bruno](../../../tools/bruno/solventa/README.md).

## Environments

| Environment | Base URL |
|---|---|
| local | `http://localhost:8787` |
| dev | `https://solventa-web-dev.ja-forerog1.workers.dev` |
| staging | `https://solventa-web-staging.ja-forerog1.workers.dev` |
| prod | `https://solventa-web-prod.ja-forerog1.workers.dev` |

Each environment has its own configuration, credentials and records. Public requests enter through the web Worker; backends are private. Having the route in code does not provision an M2M application or its permissions in WorkOS.

## Choosing an identity

| Consumer | Credential | Verification |
|---|---|---|
| Partner server | WorkOS Connect M2M JWT access token, sent as `Authorization: Bearer <token>` | Signature, issuer, audience, claims, scopes and current local partner/credential record |
| Solventa web browser | Sealed cookie from the [existing session](autenticacion.md) | WorkOS session, local user/session and this environment's web channel credential |
| Mobile application | Native flow pending | Do not use the M2M secret or web cookies as a mobile authentication solution |

`subjectToken` is the customer's internal pseudonymous identifier. It is not an access token and does not authenticate requests. The `/internal/infra` secret is also unsuitable: it is reserved for operational diagnostics. A user session alone does not establish a partner identity, business permission or consent.

## Partner: configure WorkOS and obtain a token

1. In the corresponding WorkOS environment, prepare an organization for the partner and an associated Connect M2M application; enable the `quotes:create` scope and create its credentials following the [official M2M guide](https://workos.com/docs/authkit/connect/m2m).
2. Configure `WORKOS_CONNECT_ISSUER` and `WORKOS_CONNECT_AUDIENCE` in `backend/identity-consent-ecosystem/wrangler.jsonc`, under local `vars` or the corresponding remote environment. These are public values; do not add them to `IDENTITY_AUTH_JSON`, which retains the three web session secrets. The issuer must be the exact HTTPS AuthKit origin, with one subdomain containing lowercase letters, digits or hyphens under `.authkit.app`, without a path or trailing slash. The audience is the **environment** client ID, not the M2M application's client ID. The [official Connect claims reference](https://workos.com/docs/authkit/connect/token-claims) distinguishes these values.
3. Register the partner and local credential in Identity's SQL store, linked to the issuer, organization and application. Grant only the agreed scopes and a bounded validity period. Local registration does not create WorkOS resources.
4. Keep the M2M `client_id` and `client_secret` on the partner's server. They differ from `WORKOS_API_KEY` and Solventa's web session configuration. Do not distribute the M2M secret to React or Expo.

The partner's server requests a token using this HTTP exchange; replace placeholders in memory with the securely held configuration, never in versioned files:

```http
POST <WORKOS_CONNECT_ISSUER>/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<M2M_CLIENT_ID>&client_secret=<M2M_CLIENT_SECRET>&scope=quotes%3Acreate
```

Use the response's `access_token` to call `GET /api/v1/access/partner`. Renew it by requesting another token before expiry; this flow does not represent a user or require copying a web session. Do not store tokens or secrets in SQL, logs or Git. Token issuance errors come from WorkOS and do not use Solventa's error format.

The `WORKOS_CONNECT_*` values remain empty until external setup is completed for each environment. Missing configuration makes partner token verification return `503 access_unavailable`. Do not substitute another environment's credentials. M2M setup and a real call using its token must be verified separately from builds and tests with synthetic data.

## Web: session and authorized channel

The browser signs in through `/auth/login` and the existing callback. It then calls `/auth/session` to check or refresh its session, followed by `/api/v1/access/web` with the same-origin cookie. The access response includes the internal principal; it does not expose tokens to the browser.

```js
const session = await fetch('/auth/session', { credentials: 'same-origin' });
if (!session.ok) throw new Error('session_unavailable');
const access = await fetch('/api/v1/access/web', { credentials: 'same-origin' });
const result = await access.json();
if (!access.ok) throw new Error(result.error);
// result.actor identifies the channel and authorized principal.
```

The web channel is a server credential with `provider='solventa-web'`. Identity selects its `credential_reference` through `WEB_CHANNEL_CREDENTIAL_REFERENCE` in `backend/identity-consent-ecosystem/wrangler.jsonc`, under the corresponding environment's `vars`. Initial references are `local:v1`, `dev:v1`, `staging:v1` and `prod:v1`. This is public server configuration, not a browser credential or Bearer token; do not add it to `IDENTITY_AUTH_JSON` or accept it from a request.

The selected credential must belong to an active partner, be valid and unrevoked, and have `quotes:create`. Its absence returns 403 even when the user is signed in. The client never selects the authenticated `partnerId`, `credentialId` or `clientId`. The web route rejects an Authorization header with 400 to prevent mixing credential types.

The access check does not refresh the cookie: if the session token has expired, use `/auth/session` and retry the probe once according to its result. Future web write adapters must send the actual method and Origin to the RPC: POST/PUT/PATCH/DELETE require the configured Origin; local also allows `http://localhost:5173`. The RPC accepts those methods and GET/HEAD; it does not accept OPTIONS. The probes in this guide only accept GET. There is no generic CORS API for third-party pages.

## Responses

`GET /api/v1/access/partner` and `GET /api/v1/access/web` check the fixed `quotes:create` permission. They do not accept an actor identifier or a client-selected scope. Synthetic web response example:

```json
{
  "actor": {
    "kind": "web",
    "partnerId": "10000000-0000-4000-8000-000000000001",
    "credentialId": "20000000-0000-4000-8000-000000000001",
    "scopes": ["quotes:create"],
    "principal": {
      "clientId": "30000000-0000-4000-8000-000000000001",
      "subjectToken": "40000000-0000-4000-8000-000000000001"
    }
  },
  "traceId": "50000000-0000-4000-8000-000000000001"
}
```

The partner actor has `kind:'partner'` and does not include `principal`. Its effective scopes are the intersection of the JWT and local credential scopes; a permission in only one does not grant access. `X-Trace-Id` preserves a valid incoming UUID or is generated by the server, and matches the body's `traceId`. Responses include `Cache-Control: no-store`.

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Invalid input for the check |
| 401 | `unauthorized` | Missing, invalid or expired authentication credential; invalid local user session |
| 403 | `forbidden` | Missing, inactive, expired or revoked local partner/credential; insufficient scope or unauthorized Origin |
| 405 | `method_not_allowed` | The probe only accepts GET |
| 503 | `access_unavailable` | Missing configuration or unavailable verification/SQL dependency |

Access errors include only the canonical code and correlation UUID, without provider data. If identity or permission cannot be verified, a protected operation must not proceed.

## Contract between backends

Identity exposes `authorizeApiAccessV1` through a Service Binding. It is not a public HTTP route. Acquisition can use its existing Identity binding before invoking the quoting use case. The consumer adapter builds one of these inputs from the actual request:

```ts
{ kind: 'partner', token, scope: 'quotes:create' }
{ kind: 'web', cookie, origin, method, scope: 'quotes:create' }
```

`cookie` contains the sealed cookie value, not the entire Cookie header. `origin` is the received Origin header; `method` is the actual method. The response is `{allowed:true,actor}` or `{allowed:false,error,status}`, with status 400, 401, 403 or 503. Await the call, apply the flow's deadline and treat RPC failure as unavailability; never continue with a partial actor or client-supplied IDs. Obtain actor context from Identity and translate it into the consumer's own port; do not import another backend's repositories or entities.

A positive response applies to that check and must not be stored as permanent permission. Each use verifies the signature and current local state; the RPC does not renew cookies. Do not duplicate calls to Identity without reviewing the flow's limit of one internal remote dependency. Consent authorization for signals remains an additional pending capability.

## Registering and revoking local access

From the repository root, run the Identity operator with an explicit environment and a local JSON file outside Git:

```sh
node infra/partner-access.mjs local register infra/.local/partner-registration.json
node infra/partner-access.mjs local revoke infra/.local/partner-revocation.json
```

`register` accepts exactly `partnerCode`, `provider`, `reference`, `scopes` and `expiresAt`. `partnerCode` contains up to 64 lowercase letters, digits, hyphens or underscores and starts with a letter or digit. `scopes` is exactly `["quotes:create"]`; `expiresAt` is a real future UTC date in `YYYY-MM-DDTHH:mm:ssZ` format, optionally including `.sssZ` milliseconds.

For `provider='solventa-web'`, `reference` must match the selected environment followed by a colon and a revision: `${environment}:[a-z0-9][a-z0-9-]{0,63}`, for example `local:v1`. The revision starts with a lowercase letter or digit and can contain up to 64 lowercase letters, digits or hyphens. Registering a reference does not select it automatically: it must match the server's `WEB_CHANNEL_CREDENTIAL_REFERENCE` to authorize web access.

Registration uses the database uniqueness constraint atomically: concurrent attempts for the same provider/reference produce one registration and `credential_exists` for the duplicate. The losing transaction leaves no extra partner or audit row. A serialization rejection permits one complete transaction retry after successful rollback; an uncertain commit is never retried automatically.

Synthetic local channel example; choose a future expiry before running:

```json
{
  "partnerCode": "web-local",
  "provider": "solventa-web",
  "reference": "local:v1",
  "scopes": ["quotes:create"],
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

For M2M, `provider` is `workos-connect` and `reference` contains the string produced by `JSON.stringify([issuer, organizationId, applicationId])`, without added whitespace. Use the environment's verified `org_...` organization and `client_...` application. Do not place the client secret or token in that file. `revoke` accepts only `provider` and `reference`, for example:

```json
{ "provider": "solventa-web", "reference": "local:v1" }
```

The operator uses the host/CA from `.env.infra.<ambiente>` and the securely held state in `infra/.local/runtime.<ambiente>.json`, with runtime role `solventa_<ambiente>_identity` and verified TLS. It does not run migrations or use administrative credentials for its operations; tables must exist and credentials must be restored according to the [infrastructure guide](../../infraestructura/README.md). In these paths, `<ambiente>` means the selected environment.

Registration creates or reuses an active partner and records the credential with audit data in the same transaction. An existing reference returns `credential_exists`, including revoked references; an inactive partner returns `partner_inactive`. It does not reactivate records. Revoking an unknown reference returns `credential_not_found`; repeating a revocation returns `changed:false`. Successful output contains the environment, action, IDs and `changed`, without the external reference or secrets.

### Rotate or recover the web channel credential

1. Register a new reference in the same environment, for example `local:v2`, using the same active `partnerCode`, `provider='solventa-web'`, `scopes:["quotes:create"]` and a new future `expiresAt`. Run the existing `register` command with that JSON. Preserve the old record; never reactivate a revoked credential or delete its history.
2. Set that environment's `WEB_CHANNEL_CREDENTIAL_REFERENCE` to the new reference. Deploy the configuration through the required PR/CI flow, or restart local Workers for a local change. Check `GET /api/v1/access/web` with a valid session and confirm the returned `credentialId` matches the new registration before proceeding.
3. Revoke the old reference with the existing `revoke` command. Keep the old and new registration/revocation audit records. If the old credential was already revoked, repeating revocation returns `changed:false`.

For remote environments, use the corresponding prefix, such as `dev:v2`; a local reference cannot authorize a remote channel. While a still-valid old reference remains selected, registering a replacement alone does not change access. If the old credential has already expired or been revoked, the channel remains denied until the replacement is registered and activated in the running configuration. Rotation changes no client request, cookie name or M2M reference format.

## Persistence and limitations

Identity owns `partners` and `partner_credentials`; each call checks their validity. The M2M reference is built as `JSON.stringify([issuer, organizationId, applicationId])` using verified claims. SQL stores identifiers and scopes, without JWTs, client secrets or cookies. Local revocation blocks subsequent use even while the JWT remains signed and unexpired. JWT verification does not establish immediate revocation in WorkOS: there is no per-request introspection.

This foundation does not implement quoting, consent, quotas, biometrics, mobile authorization, Pact or a permission catalog for all future resources. Local registration and revocation have transactional auditing; probes do not yet produce durable rejection audit records or automatic alerts. Each operation must implement its rules, resource authorization, persistence and tests. The web session reference remains in [authentication](autenticacion.md); public API evolution is described in [contracts](../../compartidos/contracts/README.md).

## Verification

From the root: `npm run test:authentication` verifies sessions, JWT verification, authorization and the HTTP adapter with synthetic data; `npm run test:contracts` checks the version registry/schemas, and `npm run lint:openapi` validates the specification. With local SQL prepared, `npm run test:partner-access:sql` exercises access persistence in a temporary database. These tests do not create WorkOS applications or demonstrate real M2M token issuance. Probes and manual cases are in the Bruno collection linked above.
