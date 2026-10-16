# Solventa mobile

Code: `apps/mobile`. Paths in this guide are relative to that application.

Expo/React Native application for Solventa's mobile channel.

See [Mobile architecture](architecture.md) for the implemented folder structure, dependency boundaries, composition, state management, adapters and extension rules. This guide covers setup and runtime behavior.

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

The start and web scripts bind Metro to localhost. For an Android device, use the documented USB forwarding setup. When starting a native build against that running server, pass `--no-bundler` to `expo run:android` or `expo run:ios`; those commands can otherwise start their own server with different exposure. Do not use LAN or tunnel mode for the currently affected development toolchain. See the [dependency security limits](../../development.md#dependency-security-limits).

Mobile workspace checks:

```sh
npm run lint --workspace @solventa/mobile
npm run types --workspace @solventa/mobile
npm run build --workspace @solventa/mobile
```

The current build exports for web. For native capability changes, validate the flow on a device/emulator; see [testing](../../testing.md).

## Connecting native login

The native welcome/access UI centers a single white action card on a warm off-white canvas, without a separate logo or wordmark above it. Mint supporting surfaces and deep-green actions extend the existing mobile theme. The view has no promotional header card, channel badge, lock illustration or biometric footer. Primary biometric entry (when configured) and alternative primary login have distinct button hierarchy; authenticated device settings, pending logout and retry states use the same card. The expected `biometric_locked` state has no warning banner; actual authentication, biometric and connection failures remain visible. Progress stays inside the card, without exposing the account label before validation. The screen scrolls for small displays and larger accessibility text, respects safe areas and uses a dark system status bar. This is a presentation-only change: hosted WorkOS pages, session checks, token custody and biometric policy remain unchanged. The installed app icon is unchanged. No dashboard data or business capabilities are implied by this access view.

The application uses Expo SDK 57, Expo Router in `src/app`, shared theme/assets and the app scheme `solventa` in `app.json`. WorkOS login, installation-bound biometric custody and the backend session/device lifecycle live in `src/features/authentication`, against the [native authentication contract](../../modules/identity-consent-ecosystem/mobile-authentication.md), version 1.3.0. The matching backend must be deployed before reinstall recovery is available; older environments fail closed.

Signed-out entry shows a brief welcome and product-purpose description about managing products and personal wellbeing in one place. This copy appears only before sign-in; it is not evidence of implemented policy or claims flows. The current native increment implements account access and device authentication rather than those business capabilities.

Cancelling WorkOS (browser dismissal, the cancel action or a valid `access_denied` callback) silently returns to signed-out or locked biometric entry, without a cancellation notice or trace reference in either language. The attempt/verifier is still consumed and no access is granted. Existing biometric preference remains intact; actual provider, callback, storage and connection failures still surface normally.

The canvas includes low-contrast mint rounded squares and green outlines near the edges. These static native views remain behind the scrolling content, are clipped to the screen and are excluded from touch handling and accessibility navigation. They add no image assets, animation, dependencies or authentication behavior.

The native window background in `app.json` uses `#F2F0EA`, matching the mobile theme, to avoid the former green flash before React renders. The mobile workspace includes `expo-system-ui`, which [Expo SDK 57 requires for the root background on iOS](https://docs.expo.dev/versions/v57.0.0/config/app/#backgroundcolor). The launcher/adaptive icon keeps its green identity. This native configuration/dependency change requires regeneration and rebuilding of the installed binary; Metro reload or a web preview does not update it. Verify the transition on a cold native launch without clearing application data.

### Device language

The app follows the device's preferred languages through Expo Localization, without an in-app selector or stored override. It selects the first supported language (`es` or `en`) in preference order, including regional variants such as `es-CO`, `es-419`, `en-US` and `en-GB`; if none match, it defaults to Spanish. The browser preview follows the browser's language preferences instead of the host phone.

`src/shared/i18n/messages.ts` contains matching Spanish/English catalogs and a platform-free locale resolver. The native adapter reads the device languages; the presentation hook updates on locale notifications and foreground return. Welcome copy, session states, buttons, failures, progress accessibility labels and the app-provided biometric credential prompt are localized. Changing language does not sign out, alter tokens, change device bindings or send locale data to Solventa APIs. The normal authentication checks on foreground return still apply independently of language.

The localization plugin declares both languages for Android/iOS, and `app.json` provides localized iOS Face ID privacy descriptions. Android's supported app languages may also appear in system settings; Solventa does not provide its own selector. System-owned biometric buttons remain controlled by the OS. WorkOS hosted pages use their own automatic browser/OS locale matching and environment fallback; no unsupported OAuth locale parameter is appended and no WorkOS environment setting is changed. See [Expo Localization](https://docs.expo.dev/versions/v57.0.0/sdk/localization/) and [AuthKit localization](https://workos.com/docs/authkit/hosted-ui#localization).

After installing the native dependency, regenerate/rebuild the native binary before loading the updated JavaScript. `tests/mobile-localization.test.ts` runs through `npm run test:mobile` and `npm run check`, covering regional preferences, ordering, fallback, catalog completeness and native metadata. Real-device verification must separately confirm Spanish and English welcome, signed-in, locked and error states, biometric prompt copy and return from OS language settings. A web build or catalog test is not evidence of an iOS permission prompt or native language switching.

For USB development on Windows, the Metro server must answer at the same IPv4 address used by `adb reverse`. If Node resolves `localhost` only to `::1`, start Metro with `NODE_OPTIONS=--dns-result-order=ipv4first` and verify `http://127.0.0.1:8083/status` before opening the development client. Preserve existing Node options when adding this flag. A stalled or unreachable Metro server can leave a debug build on its window background; changing that background color does not repair the connection. This is a development-server concern, not a production network requirement.

The welcome screen provides sign-in, connection retry and logout actions. It shows authenticated state only after registration, session inspection and the permission probe succeed. Backgrounding hides authenticated UI while retaining an already-unlocked session only in process memory; foreground return verifies the server before showing access again. Cold launch requires explicit biometric entry when enabled. Web export is a UI preview, not a native login substitute.

The current account label displays the WorkOS email below the signed-in status only after Solventa grants access. It is temporary display metadata, not an identifier for authorization, biometric ownership, KYC or consent. The adapter accepts a bounded, control/whitespace-free email only from a verified SDK user matching the access-token subject; decoding that subject does not replace server token verification. The label stays in the encrypted session record (biometric-protected custody when enabled), never in the installation preference, API requests or logs. Refresh can update the label; an absent refresh email retains the existing session label. Locked, loading, failed and signed-out snapshots do not expose it, and pending logout records omit it. New primary sessions never inherit another session's label. Older records remain readable without an email; a new WorkOS login populates it. Malformed optional display metadata is omitted rather than breaking authentication. This adds no backend/API contract or database change.

Android authentication opens the system browser in the existing app task (`createTask: false`, `useProxyActivity: false`, `showInRecents: false`) instead of creating a separate browser/proxy task per attempt. The generated Android activity retains Expo's `singleTask` launch mode. Completed callbacks use Router's `dismissTo('/')` to unwind to the existing home route, or replace the callback on a cold return, rather than accumulating another home screen through `replace('/')`. No native manifest patch or Back-button interception is needed. See [SDK 57 WebBrowser options](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/#webbrowseropenoptions). On a native device, repeat successful and cancelled browser entry, then press Android Back: no prior Solventa callback/home stack or stale login browser should reopen. Browser foreground/background behavior and biometric cancellation must also be rechecked after changing task options.

Use the public gateway for the selected environment:

| Environment | `EXPO_PUBLIC_API_BASE_URL` | Public WorkOS client ID |
|---|---|---|
| dev | `https://solventa-web-dev.ja-forerog1.workers.dev` | `client_01M47F52THNNZZZ4WSGACX8KA4` |
| staging | `https://solventa-web-staging.ja-forerog1.workers.dev` | `client_01M47F209CBGBJGD73ZM39ADW6` |
| prod | `https://solventa-web-prod.ja-forerog1.workers.dev` | `client_01M47F21P884580Q2GGF81NRV5` |

Read `GET <base>/api/v1/mobile/config` before login; its `clientId` is the selected environment's public client ID and its `redirectUri` is `solventa://auth/callback`. Never mix the client/token with another base. An `EXPO_PUBLIC_*` value is bundled into the application, so only public configuration belongs there. Consent sealing keys and the WorkOS API key are server credentials and are not needed by this flow.

Staging is the default and the `development` profile in `eas.json`. To select another listed environment, copy `.env.example` to `.env` in the mobile workspace, change the public base and restart Metro. The adapter rejects unlisted bases, mismatched client IDs and changed provider endpoints. A base change discards the previous device credentials before any protected call. No private credentials are needed in Expo.

### Fit the feature into the existing folders

Implemented files within the mobile workspace:

| Path | Responsibility |
|---|---|
| `src/app/auth/callback.tsx` | Thin callback view and return navigation; the root provider handles raw initial/live URLs once |
| `src/features/authentication/domain` | Session, transaction, failure and UI-safe snapshot types without SDK/platform imports |
| `src/features/authentication/application` | Login, resume, refresh and logout use cases; authentication state and ports |
| `src/features/authentication/adapters/workos.ts` | Public WorkOS PKCE/code/refresh exchanges; no server key |
| `src/features/authentication/adapters/secure-token-store.ts` | SecureStore for access/refresh tokens and pending OAuth transaction |
| `src/features/authentication/adapters/solventa-session.ts` | Config/session/access HTTP calls through the selected gateway |
| `src/features/authentication/presentation` | Session provider/hook and functional sign-in/loading/error states |
| `src/app/_layout.tsx` | Compose the session provider with the existing navigation/theme |

Keep non-route logic out of `src/app`; keep the existing welcome/brand components. Server Identity derives the principal, so do not send a `clientId` or `subjectToken` to identify the user.

### Browser, callback and token lifecycle

Use a development build or signed native build; Expo Go cannot validate this OAuth return. Sign-in checks browser availability before reading secure storage, fetching configuration or generating PKCE, so Expo Go/web report that the installed native app is required instead of a misleading connection error. Open **Solventa**, not Expo Go, on Android; an older installation must be updated after native dependency changes. Install the Expo-compatible modules from `apps/mobile`:

```sh
npx expo install expo-dev-client expo-web-browser expo-crypto expo-secure-store expo-standard-web-crypto expo-local-authentication expo-file-system @workos-inc/node
```

WebCrypto is initialized **before importing WorkOS** in `src/shared/polyfills.ts`; installing `expo-crypto` alone does not initialize the global APIs that PKCE uses. The implementation follows the [official example's polyfill](https://github.com/workos/expo-authkit-example/blob/main/src/polyfills.ts), with a fail-closed native random-values override:

```ts
import { polyfillWebCrypto } from 'expo-standard-web-crypto';
import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';

polyfillWebCrypto();
Object.defineProperty(globalThis.crypto, 'getRandomValues', {
  value: getRandomValues,
  configurable: true,
});
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: {
      digest(algorithm: string, data: BufferSource) {
        if (algorithm !== 'SHA-256') throw new Error('Unsupported PKCE digest');
        return digest(CryptoDigestAlgorithm.SHA256, data);
      },
    },
    configurable: true,
  });
}
```

This digest fallback supplies PKCE hashing, not full WebCrypto. The random-values override prevents the standard polyfill's insecure fallback if the native module fails. The package uses `main: "index.ts"`, with the polyfill first and Router last:

```ts
import './src/shared/polyfills';
import 'expo-router/entry';
```

Do not initialize it only in a screen or after the SDK import. Follow [Expo's custom-entry instructions](https://docs.expo.dev/router/installation/) and verify PKCE generation on the native development build. The official WorkOS sample currently uses SDK 54; use Expo's installer for this application's SDK 57 and do not copy its dependency versions wholesale.

`app.json` preserves the existing Android identifier `com.anonymous.solventa`, uses the same iOS bundle identifier and configures SecureStore/WebBrowser plugins. `eas.json` includes an internal development-client profile. These development identifiers are not an approved store identity. Rebuild after native module/plugin changes. Follow [Expo authentication](https://docs.expo.dev/guides/authentication/), [SDK 57 SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/) and the [official WorkOS Expo example](https://github.com/workos/expo-authkit-example).

From `apps/mobile`, build locally or through EAS, then start the development client:

```sh
npx expo run:android
# Alternatively: npx eas-cli@latest build --profile development --platform android
npx expo start --dev-client --clear --localhost
```

For iOS, use `npx expo run:ios` on macOS or the development profile with EAS. Existing generated `android`/`ios` folders must be regenerated through `npx expo prebuild --platform android --no-install` (or iOS) after these changes; do not edit native files by hand.

1. Fetch `/api/v1/mobile/config`. Instantiate WorkOS in **public-client mode** through `createWorkOS({clientId: config.clientId, timeout: 10_000, maxRetries: 0})`, without an API key. The SDK 11 public factory forwards the timeout to its fetch client; the `WorkOSWorker` subclass currently omits it.
2. Use `getAuthorizationUrlWithPKCE({provider:'authkit', redirectUri:config.redirectUri, maxAge:0})`. This requires active primary authentication rather than silent browser SSO, including after reinstall. SDK 11 generates and returns the unpredictable `state`; it does not accept a caller-supplied state on that method. Store the returned state/verifier, configuration/base and ten-minute expiry in SecureStore. Allow one attempt; do not generate a new verifier when returning.
3. Open the returned authorization URL in the operating system's authentication browser. WorkOS handles the existing email/password or Magic Auth login. Handle browser cancellation without treating it as a signed-in user.
4. On `solventa://auth/callback`, validate the exact scheme/host/path, a single code/state, the stored state, selected environment and transaction expiry. Reject unsolicited, duplicate, expired or mismatched callbacks before token exchange. Consume the attempt once; never log callback URLs, codes or verifiers.
5. Exchange with `authenticateWithCodeAndVerifier({code, codeVerifier})` on the public client. The `@workos-inc/node/worker` entry avoids Node-only runtime imports in Metro. Automatic SDK retries are disabled for code exchange and refresh; each has a ten-second timeout. Store access/refresh tokens in one SecureStore record, accessible only while unlocked and not migratable to another device. Tokens never enter UI snapshots, AsyncStorage, localStorage, logs or environment files.
6. Call `POST /api/v1/mobile/session` with the access token. Only its 200 establishes an active Solventa session; retain a pending bootstrap on transient 503 and retry boundedly with the same current token. A 401 after a new login requires resolving provider/email/local session state, not inventing a principal.
7. Call `GET /api/v1/mobile/session` on resume, then `GET /api/v1/access/mobile` to check the connection. The response principal is pseudonymous data, not a credential. A positive probe does not enable a native quote/consent endpoint; add each business route against its own contract.
8. Before each protected call, refresh tokens expiring within sixty seconds using `authenticateWithRefreshToken({refreshToken})` on the same public client. Serialized operations persist rotated tokens together before any use. JWT decoding only schedules refresh; the backend verifies authenticity. A read whose token expires in flight is retried once after refresh. A 401 with a nonexpired token or denied refresh clears credentials and requires login; it never reboots a revoked local session.
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

The HTTP adapter allows at most two attempts for network/503 failures within twelve seconds, with at most six seconds per attempt, covering response-body reading. It never retries 400/401/403. Exhausted bootstrap attempts retain only the secure pending session and expose retry/logout without granting entry. Offline/provider-pending logout retains a secure `logout` record; restarting or retrying sends DELETE, never POST/GET/access. New login is blocked while that revocation is pending. Invalid pending credentials are deleted with an explicit unconfirmed-remote-logout notice, not a successful-revocation claim. Failed secure-storage writes/deletions keep access blocked and require retry; they are not reported as completed sign-out.

### Verify on a native build

Use a synthetic/test account in the selected environment (staging by default, dev for isolated testing). Check browser login, callback return/state rejection; registration/inspection/access; active retry; process restart with SecureStore; coordinated refresh; cancellation; offline bootstrap/logout; logout followed by 401; and foreign-environment denial. Check Android and iOS independently. Web lint/types/export checks do not establish the native flow.

Run `npm run test:mobile` from the repository root. `tests/mobile-channel-authentication.test.ts` covers the lifecycle with in-memory ports plus HTTP request/response validation, replay/state/expiry, revocation, coordinated refresh and secure pending logout. It is also part of `test:authentication` and `npm run check`. These tests do not prove actual WorkOS login, Keychain/Keystore behavior or device return. Native end-to-end validation remains required; backend staging verification is separate evidence.

### Biometric activation and access

After a completed primary WorkOS login and a successful Solventa session check, select **Activar huella o rostro**. `/mobile/config` retains its original five-field contract, without a biometric capability flag. Activation uses the deployed device endpoints; confirm their presence in the selected deployment's OpenAPI before native testing. An endpoint failure never enables biometric entry. Returning from the background in the same app process preserves primary-login eligibility, but hides access until server session and permission checks succeed; it does not require logout/login merely because the app lost focus. That eligibility is not persisted: primary sessions restored after process restart still require a new primary login before activation. Already-enabled biometric sessions also resume silently while their previously unlocked credentials remain valid in process memory; they are never restored silently from protected storage after process death. Logout, revocation, denied sessions and invalid credentials retain their existing fail-closed behavior. First activation requires local session creation or verified primary authentication within ten minutes; replacing an existing installation additionally requires primary authentication newer than every previous registration. Backgrounding, refresh and UI flags do not renew this evidence. The server does not attest native biometric confirmation.

The app requires enrolled strong biometrics and SecureStore biometric support. Credentials are written under a separate `requireAuthentication` key/service and read back through the operating system prompt before registration. This matters on iOS, where creating an item does not itself prompt. No fingerprint, face, biometric template, device passcode or hardware identifier is collected. Android weak face unlock and a PIN-only device are not accepted as biometric custody. The secure key uses the current enrolled biometric set; changes that invalidate the key require primary login.

Registration calls `POST /api/v1/mobile/devices/{installationId}` with the current Bearer token. Only a successful registration and custody commit enable biometric entry; the original non-biometric token copy is removed. Cold launch after force-close or OS process termination shows a locked screen, never an automatic prompt. **Entrar con huella o rostro** explicitly opens protected custody, then validates session, permission and the binding with GET before granting entry. Cancellation, failure, missing credentials, network failure and server denial grant no entry.

A warm foreground return retains only credentials already unlocked and authorized in the same process; it performs session/access/device GET checks without reading protected credentials or reopening WorkOS. Repeated inactive/background notifications are idempotent, and stale responses cannot grant entry. No unprotected persistent token copy is introduced. Failed verification blocks access, and a subsequent background transition discards that failed biometric connection's unlocked memory. If protected credentials expire or enter the sixty-second renewal window, warm revalidation returns to explicit biometric entry instead of triggering a storage-authentication prompt automatically; renewal then follows the existing protected-storage flow. Native verification must distinguish pressing Home and returning from force-closing/reopening the app, including rapid switches, server denial, logout and renewal.

**Usar inicio de sesión** changes the entry method, not the biometric preference. Before opening WorkOS, the app suspends the local binding without calling logout or device DELETE. It retains the previous credentials only in biometric-protected custody, inaccessible through the pending primary flow. The preference contains only the installation, environment and server-verified pseudonymous owner; it is not a credential. OAuth state and replacement tokens use the regular encrypted session store until the new principal is verified. For the same account, successful primary login automatically requests native biometric confirmation and registers the new session binding before replacing protected custody. A different account never inherits the preference or previous protected tokens. Browser cancellation, rejected exchange or OAuth transaction expiry returns to the locked biometric option, also after restart; access still requires explicit native confirmation and successful server session/access/device checks. An interrupted switch with no saved transaction/session similarly returns to locked entry. Cold restoration never automatically prompts or grants access. Explicit logout/revocation, invalid registered credentials, reinstall and environment changes clear activation and preference.

Older activation markers without owner metadata acquire it only after a successful biometric unlock plus server session/access/device checks. Switching to WorkOS preserves their protected credentials so cancelling still returns to locked biometric entry; cancellation never requires an owner-metadata upgrade first. Without a verified owner, however, the app cannot safely carry the preference to a successfully completed new primary session and requires explicit activation instead. Unlock once after upgrading before testing same-account preference carryover. This is a local metadata upgrade, without backend changes or migrations.

The random installation UUID is held in an app cache marker, which is not backed up. SecureStore records must match that marker before use. A reinstall (including iOS Keychain survival), backup restore or cache purge discards local credentials and requires primary login. Cache purge can therefore conservatively sign the user out. This update also discards older records without an installation marker. `THIS_DEVICE_ONLY` alone is not reinstall detection.

After reinstall, complete active WorkOS sign-in and native confirmation before activating the new UUID. Backend 1.3.0 uses verified `auth_time` to replace the prior installation on the same still-active provider session in one transaction, leaving one active reference and retaining revoked history. Refresh alone cannot authorize replacement, and the previous UUID cannot regain access or log out its replacement. Independent provider sessions on other devices are not revoked. See the [owner policy, replay prevention and limits](../../modules/identity-consent-ecosystem/mobile-authentication.md#installation-bindings). Validate reinstall recovery against a deployment containing this revision; changing Metro alone cannot update the backend.

Explicit logout and **Revocar acceso de este dispositivo** revoke the session-bound registration in the same backend transaction as local session revocation. Offline logout removes biometric activation immediately and retains only an encrypted `phase: logout` record for remote revocation; that record cannot grant access. Do not describe remote revocation as complete before the server confirms it. Refresh uses the same protected custody while biometric access is active; Android may request another biometric confirmation when rotating credentials.

`tests/mobile-biometric-authentication.test.ts` covers custody migration, primary-login eligibility with the unchanged configuration, explicit unlock, cancellation, unavailable biometrics, server denial/offline, pending logout and simulated surviving-keychain reinstall. `tests/biometric-authentication.test.ts` remains the independent backend HTTP/OpenAPI suite. `tests/pact/mobile.consumer.test.ts` executes the actual mobile HTTP adapter for configuration, session registration/inspection/logout, permission probing and device registration/inspection/revocation, generating and comparing `solventa-mobile-solventa-web.json`. Provider verification runs the real gateway/Identity routes and device policy with synthetic provider/store collaborators; `test:authentication:sql` separately covers SQL ownership, replay, rollback, freshness and session/device revocation. These checks are not evidence of actual device biometrics. Validate strong fingerprint/Face ID, cancellation, changed enrollment, backgrounding, cold restart, logout, revocation, offline behavior and reinstall separately on Android and iOS after deploying the contract.

Failures while fetching configuration, generating PKCE or saving the OAuth transaction before opening the browser clear the incomplete attempt and resume the suspended biometric binding. The screen returns to locked entry with the actual error; access still requires explicit biometric confirmation and server session/access/device checks. If cleanup itself fails, access remains blocked rather than resuming a binding over an unconfirmed storage state.

Regression tests also cover same-account alternative entry with replacement tokens, browser cancellation/restart, pre-browser configuration/PKCE/storage recovery, rejected exchanges, foreign-account isolation, logout/revocation preference cleanup, legacy-marker upgrade and failed regular-record cleanup during suspension. Native acceptance must separately check WorkOS alternative entry, the new confirmation, background/cold restart and biometric re-entry; an earlier native result does not validate this changed path.

The [Bruno collection](../../../tools/bruno/solventa/README.md#native-connection) independently checks the backend connection after obtaining a user token securely. Deploy/HTTP verification and native validation are separate evidence.
