# Solventa API in Bruno

Open this folder as a Bruno collection and select `local`, `dev`, `staging` or `prod`. The contract and access setup are in the [Identity guide](../../../docs/modules/identity-consent-ecosystem/api-access.md); schemas are in [OpenAPI](../../../packages/contracts/openapi/v1/identity-access.yaml).

| Folder | Checks | Requirement |
|---|---|---|
| `00-public` | Health 200 and invalid session 401 | Configured Workers and web authentication |
| `10-partner` | M2M token issuance and partner permission 200 | Active Connect setup and local partner registration |
| `20-web` | Web user permission 200 | Valid test session for an active user with a verified email |
| `30-negative` | Missing token, invalid token/cookie, mixed credentials and wrong method | Complete verification configuration for the environment |
| `40-provisioned-negative` | Denied partner 403 | Partner test credential in the specified state |

Do not run the entire collection as if every scenario shared the same state: a partner credential cannot be authorized and revoked simultaneously. The GET requests are probes without quoting effects. These routes do not establish consent or mobile login.

## Variables and secrets

Environment files version `baseUrl`, `sessionCookieName` and the initially empty `issuer` and `audience` fields. Fill the latter two with the environment's public values according to the Identity guide. `audience` documents the configuration expected by the API; the M2M request does not send it or allow selecting another audience.

Populate Bruno's local secret variables when needed:

- `m2mClientId` and `m2mClientSecret`: credentials for the test M2M application.
- `webSessionCookie`: sealed value of an active test web session, without the cookie name or attributes.
- `deniedPartnerToken`: valid JWT for a revoked/inactive local credential or one without `quotes:create`, for the 403 case.

The `.bru` files declare only secret names. Bruno keeps their values outside the environment file according to its [secret documentation](https://docs.usebruno.com/secrets-management/secret-variables). Do not replace variables with literal values in requests or share reports containing headers, token issuance bodies or cookies.

The token issuance response stores `accessToken` as a runtime variable using `bru.setVar`, without `console.log` or persistence to environment files. Issue another token after switching environments or when it expires. Do not use `bru.setEnvVar` to store it: that method may write it to disk. The token belongs to the partner server; do not copy it to the mobile or web application.

Bruno and the browser do not automatically share cookies. The web case requires a test session supplied through an authorized flow; the collection does not read the browser's HttpOnly cookies. To verify the normal flow without transferring a session, use an authenticated browser and the guide's `fetch` example. Anonymous cases send an invalid synthetic cookie: disable the cookie jar when running them to avoid including other sessions.

## Running requests

1. Prepare local services using the [development guide](../../../docs/desarrollo.md), or select the corresponding deployed environment.
2. Run `00-public`. A session 503 means web configuration must first be restored.
3. For a partner, fill in issuer/audience and the registered application's secrets. Run `10-partner/01-token.bru` followed by `10-partner/02-access.bru`. Success is unavailable until external setup is complete.
4. Run `20-web/01-access.bru` with a test session. Refresh an expired session through `/auth/session` in the flow that created it. To check revocation, sign out in that flow and expect 401 from the same request.
5. Run negative cases. `40-provisioned-negative` requires the specified state before each request; do not revoke shared credentials for a test.

With Bruno CLI installed, run the public group without cookies from this folder:

```sh
bru run 00-public --env local --disable-cookies
```

Do not pass secrets through `--env-var` in shared or recorded commands. For commands and reports, see the [official options](https://docs.usebruno.com/bru-cli/run/options); authenticated request reports must omit headers and bodies. The included tests check status, error/actor, correlation and cache prevention where applicable. They do not replace Pact contracts, load validation or the quoting flow.
