# API access

Identity verifies authentication and the `quotes:create` permission for partners and authenticated web users. The endpoints in this guide are access probes: they return the authorized actor without creating quotes or querying signals or consent. The public contract is in [OpenAPI](../../../packages/contracts/openapi/v1/identity-access.yaml), and reproducible requests are in [Bruno](../../../tools/bruno/solventa/README.md).

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
| Solventa web browser | Sealed cookie from the [existing session](authentication.md) | WorkOS session with verified email, active local user/session and the web user operation policy |
| Mobile application | Native flow pending | Do not use the M2M secret or web cookies as a mobile authentication solution |

`subjectToken` is the customer's internal pseudonymous identifier. It is not an access token and does not authenticate requests. The `/internal/infra` secret is also unsuitable: it is reserved for operational diagnostics. Partner and web user identities are independent: a user session never establishes a partner identity, and a partner credential never authorizes a web user. A user session alone is not a general business permission or consent.

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

Dev and staging have separate public `WORKOS_CONNECT_*` values in Wrangler and Bruno. Local and prod remain empty until separately provisioned. Missing configuration makes partner token verification return `503 access_unavailable`; configured environments reject malformed or foreign-environment tokens with 401. Do not substitute another environment's credentials. M2M setup and a real call using its token must be verified separately from builds and tests with synthetic data.

### Provisioning a partner in WorkOS

Use the environment's administrative API key only in a trusted operator process. Through the [WorkOS APIs](https://workos.com/docs/reference/workos-connect/applications), ensure the `quotes:create` permission exists (`POST /authorization/permissions` with `slug`, `name` and `description`), create or select the partner organization, and create a Connect application with a descriptive `name`, `application_type: "m2m"`, its `organization_id` and `scopes: ["quotes:create"]`. An M2M application represents a third-party service, not a user.

Create its credential with `POST /connect/applications/{application_id}/client_secrets`. WorkOS returns the plaintext `secret` only at creation; immediately save it in authorized secret custody and never include it in Git, reports or client bundles. The application resource ID is used for administration; the returned `client_id` is used for token issuance and Identity's local credential reference. Neither is the environment client ID used as the JWT audience.

Then register the verified issuer/organization/client tuple using the operator below. Keep a finite local expiry for integration credentials and grant only the needed scope. A test partner does not onboard a real partner automatically. For rotation, WorkOS supports multiple client secrets, but Identity's local reference is per application: rotating a WorkOS secret does not reactivate an expired or revoked local registration. Deleting a secret prevents future issuance with it; use local revocation to block already-issued tokens. A replacement for a revoked local registration requires a new application/client reference under the current operator contract.

## Web: authenticated user and operation policy

The browser signs in through `/auth/login` and the existing callback. It then calls `/auth/session` to check or refresh its session, followed by `/api/v1/access/web` with the same-origin cookie. The access response includes the internal principal; it does not expose tokens to the browser.

```js
const session = await fetch('/auth/session', { credentials: 'same-origin' });
if (!session.ok) throw new Error('session_unavailable');
const access = await fetch('/api/v1/access/web', { credentials: 'same-origin' });
const result = await access.json();
if (!access.ok) throw new Error(result.error);
// result.actor identifies the authorized user principal.
```

The web user identity comes only from the cryptographically verified sealed WorkOS cookie and the active local client and session that `/auth/callback` registered. The user must have a verified email; a missing, unknown, expired or revoked local session, an inactive client or a logout returns 401. The client never selects `clientId`, `subjectToken` or any partner identifier, and no partner registration, channel credential or server-selected reference participates in web access.

The web user operation policy in `backend/identity-consent-ecosystem/src/application/api-access.ts` allows `quotes:create` and, for the user's own consent only, `consents:read` and `consents:write` (see [Consent](consent.md)). A partner credential is never allowed the consent operations. It is not a role system: it grants no access to other users' resources, and permission to manage consent is not consent to query a source. Each future operation must add its own explicit rule, resource authorization and consent checks in the owning use case. The web route rejects an Authorization header with 400 to prevent mixing credential types.

The access check does not refresh the cookie and never registers a session: if the session token has expired, use `/auth/session` and retry the probe once according to its result. Future web write adapters must send the actual method and Origin to the RPC: POST/PUT/PATCH/DELETE require the configured Origin and otherwise return 403; local also allows `http://localhost:5173`. The RPC accepts those methods and GET/HEAD; it does not accept OPTIONS. The probes in this guide only accept GET. There is no generic CORS API for third-party pages.

## Responses

The web gateway gives each access probe's Identity Service Binding call a five-second deadline, cancels it on expiry and returns `503 access_unavailable`. This deadline does not rely on client-disconnection signals. Upstream failures preserve a valid caller-supplied UUID in `X-Trace-Id` and the response body; missing or invalid values receive a generated UUID. API version headers and `Cache-Control: no-store` also apply to these failures.

`GET /api/v1/access/partner` and `GET /api/v1/access/web` check the fixed `quotes:create` operation. They do not accept an actor identifier or a client-selected operation. The actor is a discriminated union. Synthetic web response example:

```json
{
  "actor": {
    "kind": "user",
    "channel": "web",
    "principal": {
      "clientId": "30000000-0000-4000-8000-000000000001",
      "subjectToken": "40000000-0000-4000-8000-000000000001"
    },
    "operations": ["quotes:create"]
  },
  "traceId": "50000000-0000-4000-8000-000000000001"
}
```

Synthetic partner actor:

```json
{
  "kind": "partner",
  "partnerId": "10000000-0000-4000-8000-000000000001",
  "credentialId": "20000000-0000-4000-8000-000000000001",
  "scopes": ["quotes:create"]
}
```

The partner actor has no `principal`, and the user actor has no partner or credential identifiers. Partner effective scopes are the intersection of the JWT and local credential scopes; a permission in only one does not grant access. `X-Trace-Id` preserves a valid incoming UUID or is generated by the server, and matches the body's `traceId`. Responses include `Cache-Control: no-store`.

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Invalid input for the check |
| 401 | `unauthorized` | Missing, invalid or expired authentication credential, including a partner JWT whose header does not select exactly one published key; unverified email or missing/revoked local user session |
| 403 | `forbidden` | Missing, inactive, expired or revoked local partner/credential or insufficient partner scope; unauthorized Origin for a web write through the RPC |
| 405 | `method_not_allowed` | The probe only accepts GET |
| 503 | `access_unavailable` | Missing configuration or unavailable verification/SQL dependency, including a failed JWKS retrieval |

Access errors include only the canonical code and correlation UUID, without provider data. If identity or permission cannot be verified, a protected operation must not proceed.

## Contract between backends

Identity exposes `authorizeApiAccessV1` through a Service Binding. It is not a public HTTP route. Acquisition can use its existing Identity binding before invoking the quoting use case. The consumer adapter builds one of these inputs from the actual request:

```ts
{ kind: 'partner', token, operation: 'quotes:create' }
{ kind: 'web', cookie, origin, method, operation: 'quotes:create' }
```

`cookie` contains the sealed cookie value, not the entire Cookie header. `origin` is the received Origin header; `method` is the actual method. An unknown operation returns 400 before any credential or session lookup. The response is `{allowed:true,actor}`, where `actor` is the partner or user actor above, or `{allowed:false,error,status}`, with status 400, 401, 403 or 503. Await the call, apply the flow's deadline and treat RPC failure as unavailability; never continue with a partial actor or client-supplied IDs. Obtain actor context from Identity, branch on `actor.kind` and translate it into the consumer's own port; do not import another backend's repositories or entities.

A positive response applies to that check and must not be stored as permanent permission. Each use verifies the signature and current local state; the RPC does not renew cookies. Do not duplicate calls to Identity without reviewing the flow's limit of one internal remote dependency. Consent authorization for signals remains an additional pending capability.

## Registering and revoking partner access

Registration applies only to M2M partners; web users need no registration beyond their login. From the repository root, run the Identity operator with an explicit environment and a local JSON file outside Git:

```sh
node infra/partner-access.mjs local register infra/.local/partner-registration.json
node infra/partner-access.mjs local revoke infra/.local/partner-revocation.json
```

`register` accepts exactly `partnerCode`, `provider`, `reference`, `scopes` and `expiresAt`. `partnerCode` contains up to 64 lowercase letters, digits, hyphens or underscores and starts with a letter or digit. `scopes` is exactly `["quotes:create"]`; `expiresAt` is a real future UTC date in `YYYY-MM-DDTHH:mm:ssZ` format, optionally including `.sssZ` milliseconds.

Registration uses the database uniqueness constraint atomically: concurrent attempts for the same provider/reference produce one registration and `credential_exists` for the duplicate. The losing transaction leaves no extra partner or audit row. A serialization rejection permits one complete transaction retry after successful rollback; an uncertain commit is never retried automatically.

`provider` must be `workos-connect`; any other provider returns `invalid_reference`. `reference` contains the string produced by `JSON.stringify([issuer, organizationId, applicationId])`, without added whitespace. Use the environment's verified `org_...` organization and `client_...` application. Do not place the client secret or token in that file. `revoke` accepts only `provider` and `reference`. Synthetic registration example; choose a future expiry before running:

```json
{
  "partnerCode": "synthetic-partner",
  "provider": "workos-connect",
  "reference": "[\"https://synthetic.authkit.app\",\"org_synthetic\",\"client_synthetic\"]",
  "scopes": ["quotes:create"],
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

The operator uses the host/CA from `.env.infra.<environment>` and the securely held state in `infra/.local/runtime.<environment>.json`, with runtime role `solventa_<environment>_identity` and verified TLS. It does not run migrations or use administrative credentials for its operations; tables must exist and credentials must be restored according to the [infrastructure guide](../../infrastructure/README.md). In these paths, `<environment>` means the selected environment.

Registration creates or reuses an active partner and records the credential with audit data in the same transaction. An existing reference returns `credential_exists`, including revoked references; an inactive partner returns `partner_inactive`. It does not reactivate records. Revoking an unknown reference returns `credential_not_found`; repeating a revocation returns `changed:false`. Successful output contains the environment, action, IDs and `changed`, without the external reference or secrets.

## Persistence and limitations

Identity owns `partners` and `partner_credentials`; each call checks their validity. Web users have no rows in these tables. The M2M reference is built as `JSON.stringify([issuer, organizationId, applicationId])` using verified claims. SQL stores identifiers and scopes, without JWTs, client secrets or cookies. Local revocation blocks subsequent use even while the JWT remains signed and unexpired. JWT verification does not establish immediate revocation in WorkOS: there is no per-request introspection.

This foundation does not implement quoting, consent, quotas, biometrics, mobile authorization, Pact or a permission catalog for all future resources. Local registration and revocation have transactional auditing; probes do not yet produce durable rejection audit records or automatic alerts. Each operation must implement its rules, resource authorization, persistence and tests. The web session reference remains in [authentication](authentication.md); public API evolution is described in [contracts](../../shared/contracts/README.md).

## Verification

The Identity composition root (`src/index.ts`) builds SQL and WorkOS adapters and injects the access authorizer through `createHttp({ authorizeApiAccess })`. The HTTP and RPC adapter share the same dependency-driven authorization function; HTTP tests use in-memory dependencies without patching production adapters. Existing `/auth/*` composition and behavior are unchanged.

`npm run test:runtime` executes the actual bundled gateway in local workerd through Wrangler's installed Miniflare, with a synthetic Identity service. It verifies forwarding, the five-second deadline, upstream cancellation and correlated 503 responses. It does not establish remote SQL cancellation or a complete user flow.

From the root: `npm run test:authentication` verifies sessions, JWT verification, partner and web user authorization and the HTTP adapter with synthetic data; `npm run test:contracts` checks the version registry/schemas, and `npm run lint:openapi` validates the specification. With local SQL prepared, `npm run test:partner-access:sql` exercises partner registration, revocation, concurrency and audit, plus web user access without partner records and after session revocation, in a temporary database. These tests do not create WorkOS applications or demonstrate real M2M token issuance. Probes and manual cases are in the Bruno collection linked above.
