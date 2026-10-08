# Identity and authentication

Private Worker with its own schema, runtime role and Hyperdrive. WorkOS AuthKit verifies identity through OAuth with PKCE. Web routes `/auth/*` through a Service Binding; Identity keeps its internal user, state and session. SDKs and SQL remain in adapters.

| Route | Method | Result |
|---|---|---|
| `/auth/login` | GET | AuthKit redirect; encrypted OAuth transaction valid for ten minutes |
| `/auth/callback` | GET | Validates state/PKCE, token and email; registers user/session and redirects to `/` |
| `/auth/session` | GET | 200 with `authenticated` and `principal: {clientId, subjectToken}`; 401 without a valid session |
| `/auth/logout` | POST | Requires same Origin, revokes the local session and returns `logoutUrl` to complete provider logout |

Responses are not cached. Tokens/refresh tokens remain in a sealed cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no Domain and the `__Host-` prefix remotely. Local HTTP is allowed only on localhost. Never deliver tokens to React or store them in localStorage, SQL, logs or Git. The adapter verifies signature and issuer for the configured client. When the access token expires, SDK refresh is used; transient failure returns 503 and preserves the cookie. Provider validation failures also preserve cookies: a concurrent request may have installed a refreshed session. If SQL finds no active, current principal, the 401 response clears the cookie; logout clears it too. Each session checks active user, ownership, expiry and local revocation in SQL. Maximum local duration: seven days.

Registration commits client, identity link, session, audit and creation event in the owner's transaction. A registration race fails safely and allows login to restart. Logout revokes in SQL first, then attempts provider logout. External WorkOS revocation is reflected when the token expires/refreshes: no provider revocation-event consumer exists yet.

## Configuration and running

Each environment needs its own WorkOS application, exact Redirect URI, Initiate login URI and Sign-out URI. `AUTH_ORIGIN` and `AUTH_REDIRECT_URI` are in Wrangler. Secrets: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and `AUTH_COOKIE_PASSWORD` (64 random hexadecimal characters, held separately per environment). Do not share keys. Production requires enabling its WorkOS environment before configuring credentials.

In Authentication, enable email/password and Magic Auth; keep social providers disabled until an approved integration exists. The operator's Outlook account does not imply enabling Microsoft as a product provider.

In Branding, use SVGs from `packages/assets/brand`: green logo/icon for light mode and white for dark mode, IBM Plex Sans and System appearance. Light/dark colors: background `#F7F6F3`/`#062F2A`, button/links `#0B6B5F`/`#12D9B8`, button text `#FFFFFF`/`#062F2A`. The editor permits copying branding alone between environments; save and check the actual AuthKit page afterward. Language follows AuthKit localization according to browser preferences.

Local: restore those three values in this backend's `.dev.vars`. From the root, run `npm run infra:up`, `npm run build --workspace @solventa/web` and `npm run dev:backend`. Open `http://localhost:8787`. Vite on 5173 redirects `/auth` to the Worker; callback returns to 8787.

CD restores `IDENTITY_AUTH_JSON` from each GitHub Environment: an object containing `environment` and `secrets` with those three keys. Local custody: `infra/.local/identity.<environment>.secrets.json`; never print it. Missing configuration or a different environment blocks deployment.

WorkOS environment keys use the `sk_` prefix; it does not identify test versus production. Create/custody each key in its WorkOS environment with its own application, and load it only into the matching GitHub Environment. The `environment` marker validates the custody destination, not the actual scope of a key. See [WorkOS API authentication](https://workos.com/docs/reference/api-authentication).

Tests: `npm run test:authentication` and, with local SQL running, `npm run test:authentication:sql`. The latter uses an independent temporary database with synthetic data; it does not empty the developer's database.

## Pending boundaries

The [API access foundation](api-access.md) reuses this session to authorize `quotes:create` probes and private RPC calls. `subjectToken` is an internal pseudonymous identifier, not a Bearer credential. Web access depends on the verified session, its local record and the explicit user operation policy, never on a partner credential. Business authorization neither refreshes cookies nor registers sessions; refresh remains in `/auth/session`.

A session grants neither consent, operational permissions nor access to other owners. Mobile needs its own PKCE login and native secure storage; do not reuse web cookies or server keys. Device tables exist, but biometrics, device registration/revocation and native validation require implementation. A row does not establish biometrics.

See [SQL model](../../infrastructure/data-model.md), [boundaries](../../architecture.md) and [operations](../../infrastructure/README.md).
