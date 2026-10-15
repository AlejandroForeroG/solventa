# Solventa API in Bruno

Open this folder as a Bruno collection and select `local`, `dev`, `staging` or `prod`. The contract and access setup are in the [Identity guide](../../../docs/modules/identity-consent-ecosystem/api-access.md); schemas are in [OpenAPI](../../../packages/contracts/openapi/v1/identity-access.yaml).

| Folder | Checks | Requirement |
|---|---|---|
| `00-public` | Health 200 and invalid session 401 | Configured Workers and web authentication |
| `10-partner` | M2M token issuance and partner permission 200 | Active Connect setup and local partner registration |
| `20-web` | Web user permission 200 | Valid test session for an active user with a verified email |
| `30-negative` | Missing token, invalid token/cookie, mixed credentials and wrong method | Complete verification configuration for the environment |
| `40-provisioned-negative` | Denied partner 403 | Partner test credential in the specified state |
| `50-quotes` | Create, replay and conflict for a partner; create as a web user | Deployed quote routes, migrated Acquisition schema and its HMAC secret |
| `60-mobile` | Public config, session registration/inspection, access, installation registration/inspection/revocation and logout | A WorkOS user access token for the selected environment; disable cookies |

Do not run the entire collection as if every scenario shared the same state: a partner credential cannot be authorized and revoked simultaneously. The GET requests are probes without quoting effects. These routes do not establish consent or native UI/deep-link validation.

## Variables and secrets

Environment files version `baseUrl`, `sessionCookieName`, `issuer` and `audience`, plus an empty `mobileInstallationId`. Set the latter locally to a fresh lowercase random UUID v4 for one synthetic native installation and keep it unchanged for registration replays, inspection and revocation. It is not a credential; do not use a hardware identifier. Do not commit populated environment values. Dev, staging and prod contain their own configured public issuer/audience; local remains empty until separately provisioned. Use credentials registered for the selected environment. `audience` documents the configuration expected by the API; the M2M request does not send it or allow selecting another audience.

Populate Bruno's local secret variables when needed:

- `m2mClientId` and `m2mClientSecret`: credentials for the test M2M application.
- `webSessionCookie`: sealed value of an active test web session, without the cookie name or attributes.
- `mobileAccessToken`: current WorkOS USER access token from native PKCE, held as a local secret variable. Never a refresh token, server API key or M2M credential.
- `deniedPartnerToken`: valid JWT for a revoked/inactive local credential or one without `quotes:create`, for the 403 case.
- `quoteIdempotencyKey`: a new arbitrary key for one synthetic quote attempt; keep it unchanged for the replay and conflict cases. Store it as a local variable even though it is not a credential.

The `.bru` files declare only secret names. Bruno keeps their values outside the environment file according to its [secret documentation](https://docs.usebruno.com/secrets-management/secret-variables). Do not replace variables with literal values in requests or share reports containing headers, token issuance bodies or cookies.

The token issuance response stores `accessToken` as a runtime variable using `bru.setVar`, without `console.log` or persistence to environment files. Issue another token after switching environments or when it expires. Do not use `bru.setEnvVar` to store it: that method may write it to disk. The token belongs to the partner server; do not copy it to the mobile or web application.

Bruno and the browser do not automatically share cookies. The web case requires a test session supplied through an authorized flow; the collection does not read the browser's HttpOnly cookies. To verify the normal flow without transferring a session, use an authenticated browser and the guide's `fetch` example. Anonymous cases send an invalid synthetic cookie: disable the cookie jar when running them to avoid including other sessions.

## Running requests

1. Prepare local services using the [development guide](../../../docs/development.md), or select the corresponding deployed environment.
2. Run `00-public`. A session 503 means web configuration must first be restored.
3. For a partner in dev, staging or prod, preserve the versioned issuer/audience and populate only the local secret variables with the application's credentials registered for that environment. Local requires its own issuer/audience and external provisioning first. Run `10-partner/01-token.bru` followed by `10-partner/02-access.bru`.
4. Run `20-web/01-access.bru` with a test session. Refresh an expired session through `/auth/session` in the flow that created it. To check revocation, sign out in that flow and expect 401 from the same request.
5. Run negative cases. `40-provisioned-negative` requires the specified state before each request; do not revoke shared credentials for a test.
6. After the quote feature is deployed and the Acquisition migrations and `QUOTE_HMAC_KEY` are verified, set a fresh local `quoteIdempotencyKey` and run `50-quotes/01-create-partner.bru`, `02-replay-partner.bru` and `03-conflict-partner.bru` in order. The sample customer is synthetic. The first request returns 201, or 200 if this exact actor, key and body were already submitted; replay returns 200 and a changed body returns 409. For a web test session, run `04-create-web.bru` separately. A normal browser login and quote still need a browser flow test.

With Bruno CLI installed, run the public group without cookies from this folder:

```sh
bru run 00-public --env local --disable-cookies
```

Do not pass secrets through `--env-var` in shared or recorded commands. For commands and reports, see the [official options](https://docs.usebruno.com/bru-cli/run/options); authenticated request reports must omit headers and bodies. The included tests check status, error/actor, correlation and cache prevention where applicable. They do not replace Pact contracts, load validation or the quoting flow.

The quote requests perform persistent writes. Never run the quote folder as part of an unattended collection run against an environment with real customer data. A 500 or 503 may follow an uncertain write outcome; repeat with the same key and unchanged body to reconcile it.

## Native connection

Installation UUIDs are case-insensitive. The device responses use canonical lowercase; the included assertions normalize the selected environment value accordingly. A case-only retry must return the same device ID, including for bindings stored by an older deployment with uppercase UUID text.

Follow the [mobile integration guide](../../../docs/channels/mobile/README.md#connecting-native-login) for Expo PKCE and secure storage and the [device contract](../../../packages/contracts/openapi/v1/mobile-authentication.yaml). Disable Bruno's cookie jar for all `60-mobile` requests. Read config, then set the local secret `mobileAccessToken` from a synthetic native test account in the same environment. These requests mutate session/device records and revoke that account's provider session; use them separately from quote flows, never as an unattended full-collection run. Do not export tokens/headers/bodies in reports. Backend requests do not demonstrate a device browser callback or biometric flow.

1. Run `01-config` (200). It retains the original closed configuration response; it does not advertise device capability. Before device checks, verify that the selected environment's deployed OpenAPI includes the device routes (contract 1.2.0) and its deployment succeeded. Older deployments without these routes cannot exercise this flow.
2. Run `02-register` twice (200 with the same principal), `03-session` (200) and `04-access` (200, user/mobile actor).
3. Within ten minutes of the first local registration, set `mobileInstallationId` in the selected local environment and run `05-register-device` twice. Both return 200 with the same device ID and `active`; keep the installation value unchanged. A different installation on the same provider session returns 401. Run `06-inspect-device` (200, active).
4. Choose a revocation path. To test device DELETE, run `07-revoke-device` (200, revoked). It also revokes the local and provider sessions. To test session logout instead, skip `07` and run `08-logout` (200, signed_out); this revokes associated bindings too. Use a new primary login/session to test the other path.
5. After either path, inspection/access, device GET/POST and session registration with the same still-valid token return 401; the binding cannot reactivate. The included requests assert the positive paths, so adjust expectations deliberately for these negative manual checks. Same-owner DELETE can return 200 on retry while the token still verifies. After provider token expiry or rejection, obtain a new login rather than treating a 401 as successful revocation.

Device calls send no body. Invalid/non-v4 installation IDs or a Cookie header return 400; missing, foreign-environment or foreign-owner credentials return 401. Unsupported device methods return 405 with `Allow: GET, POST, DELETE`. Unavailable provider/SQL dependencies return 503. A 503 after revocation can mean the local block committed and the provider step is pending: retry DELETE boundedly with the same installation and still-valid user token, never re-register to undo the local block. A 503 after registration can follow an uncertain commit: retry the same installation/session, preserving replay safety. The request/response trace UUID connects logout to its session/device audit, outbox and historical capture.
