# Solventa mobile

Code: `apps/mobile`. Paths in this guide are relative to that application.

Expo/React Native application for Solventa's mobile channel.

## Structure

- `src/app`: routes and navigation composition with Expo Router.
- `src/features`: features organized by business capability.
- `src/theme`: shared application visual tokens.
- `@solventa/assets`: brand and colors shared with other channels.

Keep routes thin. Each capability's UI and logic live in its `src/features` directory; reusable code between capabilities may go in `src/shared` when a concrete need exists.

## Development

Run from the monorepo root:

```sh
npm install
npm run dev:mobile
```

Mobile workspace checks:

```sh
npm run lint --workspace @solventa/mobile
npm run types --workspace @solventa/mobile
npm run build --workspace @solventa/mobile
```

The current build exports for web. For native capability changes, validate the flow on a device/emulator; see [testing](../../testing.md).

## Connecting native login

The current application uses Expo SDK 57, Expo Router in `src/app`, a welcome feature in `src/features/welcome`, shared theme/assets and the app scheme `solventa` in `app.json`. Keep that structure. The backend connection is defined in [native authentication](../../modules/identity-consent-ecosystem/mobile-authentication.md); the app still needs its login/callback/storage implementation. No biometric change is part of this connection.

Use the public gateway for the selected environment:

| Environment | `EXPO_PUBLIC_API_BASE_URL` | Public WorkOS client ID |
|---|---|---|
| dev | `https://solventa-web-dev.ja-forerog1.workers.dev` | `client_01M47F52THNNZZZ4WSGACX8KA4` |
| staging | `https://solventa-web-staging.ja-forerog1.workers.dev` | `client_01M47F209CBGBJGD73ZM39ADW6` |
| prod | `https://solventa-web-prod.ja-forerog1.workers.dev` | `client_01M47F21P884580Q2GGF81NRV5` |

Read `GET <base>/api/v1/mobile/config` before login; its `clientId` is the selected environment's public client ID and its `redirectUri` is `solventa://auth/callback`. Never mix the client/token with another base. An `EXPO_PUBLIC_*` value is bundled into the application, so only public configuration belongs there. The consent ZIP's sealing key and WorkOS API key are server credentials and are not needed by this flow.

### Fit the feature into the existing folders

Suggested files, to be implemented within the mobile workspace:

| Path | Responsibility |
|---|---|
| `src/app/auth/callback.tsx` | Thin Expo Router callback; delegate incoming code/state/error to the authentication feature |
| `src/features/authentication/application` | Login, resume, refresh and logout use cases; authentication state and ports |
| `src/features/authentication/adapters/workos.ts` | Public WorkOS PKCE/code/refresh exchanges; no server key |
| `src/features/authentication/adapters/secure-token-store.ts` | SecureStore for access/refresh tokens and pending OAuth transaction |
| `src/features/authentication/adapters/solventa-session.ts` | Config/session/access HTTP calls through the selected gateway |
| `src/features/authentication/presentation` | Session provider/hook and functional sign-in/loading/error states |
| `src/app/_layout.tsx` | Compose the session provider with the existing navigation/theme |

Keep non-route logic out of `src/app`; keep the existing welcome/brand components. Server Identity derives the principal, so do not send a `clientId` or `subjectToken` to identify the user.

### Browser, callback and token lifecycle

Use a development build or signed native build; Expo Go cannot validate this OAuth return. Install the Expo-compatible modules from `apps/mobile`:

```sh
npx expo install expo-dev-client expo-web-browser expo-crypto expo-secure-store expo-standard-web-crypto @workos-inc/node
```

Initialize WebCrypto **before importing WorkOS**; installing `expo-crypto` alone does not set up the global APIs that PKCE uses. Follow the [official example's polyfill](https://github.com/workos/expo-authkit-example/blob/main/src/polyfills.ts), using `expo-standard-web-crypto` for random values and Expo Crypto for `subtle.digest`. Suggested `src/shared/polyfills.ts`:

```ts
import { polyfillWebCrypto } from 'expo-standard-web-crypto';
import { digest } from 'expo-crypto';

polyfillWebCrypto();
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: { digest },
    configurable: true,
  });
}
```

This digest fallback supplies the operation used for PKCE, not a complete WebCrypto implementation for other cryptographic features. In `apps/mobile/package.json`, change the current `main: "expo-router/entry"` to `main: "index.ts"`; create `apps/mobile/index.ts` with the polyfill first and Router last:

```ts
import './src/shared/polyfills';
import 'expo-router/entry';
```

Do not initialize it only in a screen or after the SDK import. Follow [Expo's custom-entry instructions](https://docs.expo.dev/router/installation/#custom-entry-point) and verify PKCE generation on the native development build. The official WorkOS sample currently uses SDK 54; use Expo's installer for this application's SDK 57 and do not copy its dependency versions wholesale.

Configure native bundle/package identifiers and a development build profile before building. Preserve `scheme: "solventa"`. Rebuild after native configuration/plugin changes. Follow [Expo authentication](https://docs.expo.dev/guides/authentication/), [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/) and the [official WorkOS Expo example](https://github.com/workos/expo-authkit-example), adapting its sample library placement to the feature structure above. Those examples do not replace the callback state checks or Solventa registration below.

1. Fetch `/api/v1/mobile/config`. Instantiate WorkOS in **public-client mode**: `new WorkOS({clientId: config.clientId})`, without an API key.
2. Generate an unpredictable OAuth `state`. Use `getAuthorizationUrlWithPKCE({provider:'authkit', redirectUri:config.redirectUri, state})`. Store the returned code verifier with state, environment/base and a ten-minute expiry in SecureStore. Allow one pending attempt; do not generate a second verifier when returning to the app.
3. Open the returned authorization URL in the operating system's authentication browser. WorkOS handles the existing email/password or Magic Auth login. Handle browser cancellation without treating it as a signed-in user.
4. On `solventa://auth/callback`, validate the exact scheme/host/path, a single code/state, the stored state, selected environment and transaction expiry. Reject unsolicited, duplicate, expired or mismatched callbacks before token exchange. Consume the attempt once; never log callback URLs, codes or verifiers.
5. Exchange with `authenticateWithCode({code, codeVerifier})` on the public client. Securely store access/refresh tokens together; do not use AsyncStorage, localStorage, logs or environment files. Never enable web sealed-cookie mode on native.
6. Call `POST /api/v1/mobile/session` with the access token. Only its 200 establishes an active Solventa session; retain a pending bootstrap on transient 503 and retry boundedly with the same current token. A 401 after a new login requires resolving provider/email/local session state, not inventing a principal.
7. Call `GET /api/v1/mobile/session` on resume, then `GET /api/v1/access/mobile` to check the connection. The response principal is pseudonymous data, not a credential. A positive probe does not enable a native quote/consent endpoint; add each business route against its own contract.
8. Before token expiry, use `authenticateWithRefreshToken({refreshToken})` on the same public client. Serialize refresh requests and persist each rotated access/refresh pair atomically. Retry the original read once with the new access token. A denied refresh or revoked/expired local session returns to login; never repeatedly bootstrap a revoked reference.
9. On logout call `DELETE /api/v1/mobile/session` with a current token, then clear SecureStore and authenticated navigation after 200. A 503 may mean local revocation succeeded while provider revocation is pending; retry boundedly. If offline, lock the UI immediately and keep only a secure pending logout for later revocation; distinguish local sign-out from completed server sign-out. Refresh if needed before a pending revocation; if WorkOS already denies refresh, discard the unusable tokens.

Backend requests need no body or Cookie header. An adapter can use this basic shape, with the token obtained from the secure session port:

```ts
const response = await fetch(`${apiBaseUrl}/api/v1/mobile/session`, {
  method: 'POST',
  credentials: 'omit',
  headers: { Authorization: `Bearer ${accessToken}` },
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
// result.principal and result.channel describe the active Solventa session.
```

For GET inspection/access and DELETE logout, reuse the same headers and `credentials:'omit'`, choosing the appropriate path/method. Handle 400 as a malformed/mixed request, 401 as invalid or inactive session, 403 as denied permission and 503 as a transient dependency failure. Include only the returned trace UUID in diagnostics; omit authorization headers, callbacks and token bodies. Do not add broad CORS to make a browser export simulate native authentication.

### Verify on a native build

Use a synthetic/test account in dev. Check browser login, callback return and state rejection; successful registration/inspection/access; active registration retry; process restart with SecureStore; one coordinated refresh; cancellation; offline bootstrap/logout; logout followed by 401; and a token from another environment denied with 401. Check Android and iOS deep links independently. Existing web lint/types/export checks do not establish this native flow.

The [Bruno collection](../../../tools/bruno/solventa/README.md#native-connection) independently checks the backend connection after obtaining a user token securely. Deploy/HTTP verification and native validation are separate evidence.
