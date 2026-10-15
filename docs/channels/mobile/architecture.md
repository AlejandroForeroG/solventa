# Mobile architecture

This document describes the implemented architecture of `apps/mobile`, not a target-state scaffold. Solventa is an insurance application; the current native channel implements account authentication, biometric device access and a welcome/session screen. Native policy consultation, claims reporting, payments and quote journeys are not implemented by this increment.

The [mobile guide](README.md) owns setup, environment values, operational commands and detailed authentication behavior. The [system architecture](../../architecture.md) owns backend boundaries; the [native authentication guide](../../modules/identity-consent-ecosystem/mobile-authentication.md) and its [OpenAPI specification](../../../packages/contracts/openapi/v1/mobile-authentication.yaml) own the server contract. This document maps mobile responsibilities and dependencies without replacing those sources.

## Organization

The channel uses Expo/React Native, Expo Router and feature-oriented folders. Organize code by business capability, keeping navigation separate from feature logic and platform integrations separate from the core. Presentation and adapters depend on domain/application contracts, not the reverse.

The following layout is a general reference, not an exhaustive file inventory or a fixed template. Feature names, routes and supporting files can evolve while preserving these responsibilities and dependency boundaries.

```text
apps/mobile/
  <entry-point>                    Required initialization and Router bootstrap
  <configuration>                  Native settings, plugins and build profiles
  src/
    app/                           Routes and navigation composition only
    features/
      <capability>/
        domain/                    Business values and rules
        application/               Use cases and required ports
        adapters/                  External services and platform integrations
        presentation/              Screens, components and hooks
    shared/                        Concrete cross-feature technical capabilities
    theme/                         Shared visual tokens
```

Create only the layers a capability actually needs; a presentation-only feature does not require empty domain, application or adapter folders. Keep shared code limited to demonstrated cross-feature needs. The sections below describe the current implementations of these boundaries.

Generated `android` and `ios` projects are build outputs of Expo configuration, not another location for feature logic. Change native behavior through `app.json`, supported plugins and dependencies, then regenerate/rebuild. Launcher assets remain in the mobile application; shared brand colors come from `@solventa/assets`.

## Responsibilities and dependency direction

| Boundary | Implemented responsibility | Must not own |
|---|---|---|
| Routes (`src/app`) | Mount screens and compose navigation/providers | Token exchange, HTTP requests or persistence rules |
| Presentation | Render UI-safe state, request actions and translate platform lifecycle events | Credentials, server authorization decisions or provider-specific business rules |
| Application | Coordinate authentication, refresh, session verification, biometric activation and revocation through ports | React hooks, Expo APIs, `fetch`, WorkOS or SQL |
| Domain | Define session/transaction values, failures and observable authentication states | Platform dependencies or infrastructure implementations |
| Adapters | Implement browser, HTTP, provider, validation and secure-storage behavior | Reassign server ownership or grant business access from local UI state |
| Shared/theme | Supply concrete cross-feature startup, localization and visual capabilities | A global business-services layer or shared backend entities |

The application consumes the ports in [`application/ports.ts`](../../../apps/mobile/src/features/authentication/application/ports.ts). Adapters implement those ports. The composition root is allowed to import both so it can inject implementations. An adapter does not become part of the domain merely because it contains platform-free code: for example, credential-record validation and custody migration remain adapters around storage.

## Composition, state and navigation

1. [`index.ts`](../../../apps/mobile/index.ts) initializes WebCrypto before Router loads modules that import WorkOS. This ordering is required for native PKCE generation.
2. [`_layout.tsx`](../../../apps/mobile/src/app/_layout.tsx) mounts `AuthenticationProvider` above the Router stack. Navigation and the native window use the channel's light background.
3. [`AuthenticationProvider`](../../../apps/mobile/src/features/authentication/presentation/AuthenticationProvider.tsx) creates one `Authentication` instance for its mounted lifetime. It injects the selected API base, `TokenStore`, `IdentityProvider`, `SessionApi`, `AuthBrowser`, clock, callback parser and `BiometricVault`.
4. The provider converts initial/live links and `AppState` changes into application operations. It removes listeners on unmount. Callback validation and consumption belong to the application/adapter flow, not to a route effect.
5. `useAuthentication` exposes the current `AuthSnapshot` through `useSyncExternalStore`, together with application actions. React Context supplies the coordinator instance; it is not a second copy of session state.
6. [`WelcomeScreen`](../../../apps/mobile/src/features/welcome/presentation/WelcomeScreen.tsx) renders that snapshot and invokes actions. It never receives access/refresh tokens. The callback route uses `dismissTo('/')` after processing rather than accumulating another welcome screen.

`Authentication` serializes operations and guards concurrent login attempts, stale lifecycle results and pending logout. The UI states are `loading`, `signedOut`, `authorizing`, `locked`, `biometricPrompt`, `authenticated`, `blocked` and `logoutPending`. Persisted session phases (`bootstrap`, `active`, `logout`) serve recovery and must not be treated as interchangeable with UI states.

The snapshot may contain server-verified principal metadata and a display-only email after access succeeds. It never contains credentials. The email is not an authorization or biometric-ownership key.

## Ports and adapters

| Port | Implementation | External boundary |
|---|---|---|
| `IdentityProvider` | `adapters/workos.ts` | Public-client WorkOS PKCE, code exchange and refresh; no server API key |
| `AuthBrowser` | `adapters/browser-session.ts` and `adapters/auth-browser.ts` | Testable browser policy plus Expo system authentication browser |
| `SessionApi` | `adapters/solventa-session.ts` | Allowed Solventa gateway environment; validated configuration/session/access/device responses |
| `TokenStore` | `adapters/credentials.ts`, composed by `adapters/secure-token-store.ts` | Encrypted session and pending OAuth/logout records |
| `BiometricVault` | The same credential composition | Installation-bound biometric custody, activation metadata and explicit credential release |

`adapters/callback.ts` parses the exact callback shape. `adapters/validation.ts` validates provider, stored-record and API data. These boundaries reject malformed or foreign-environment values before they can establish an authenticated snapshot.

## Authentication and server ownership

The primary flow reads public configuration, opens WorkOS with PKCE, validates the callback/state, exchanges the code and registers the native session. Session inspection and the mobile permission probe must succeed before the app presents authenticated access. Biometric activation additionally requires native confirmation, server device registration and a committed protected credential record.

The mobile HTTP adapter calls the public web gateway under `/api/v1`, using bearer credentials and omitting cookies. The gateway routes native identity operations to Identity, Consent & Ecosystem. The app does not connect to SQL, use internal Service Bindings or call another backend's persistence layer. WorkOS authenticates the primary identity; Solventa's backend verifies the session and authorization. A successful permission probe is not an implemented native quote flow.

Detailed endpoints, error schemas, validation rules and device-registration requirements remain in the [owning contract](../../modules/identity-consent-ecosystem/mobile-authentication.md). New channel capabilities must use their owning module's public contracts rather than importing backend domain objects or embedding server decisions in a screen.

## Credential custody and lifecycle

- `secure-token-store.ts` injects Expo SecureStore, strong-biometric checks and an installation marker into the testable credential adapter. Tokens are stored as one encrypted record; biometric-enabled credentials use a separate authenticated key/service.
- The installation UUID is random, not a hardware identifier. A cache marker detects missing installations even if a platform keychain record survives. Biometric metadata is not a token and cannot grant access.
- Cold launch with biometrics enabled stays locked until the user explicitly requests biometric entry. Native confirmation releases credentials; the server session, permission and device binding are then checked.
- Warm background return can retain an already-unlocked session only in process memory. It hides authenticated UI and checks the server before restoring access. It neither creates an unprotected persistent token copy nor treats cached state as permission.
- Switching to WorkOS is not revocation. The application suspends the existing biometric preference during the primary attempt and reconciles it after a verified account result. Cancellation returns silently to the appropriate entry screen without granting access.
- Logout/revocation blocks local access immediately. A secure pending logout can support remote retry, but it cannot authenticate or bootstrap a new session. Storage or authorization failures remain fail-closed.

No fingerprint, face template, device passcode or biometric sensor data enters the application or backend. The server device registration does not attest that a biometric prompt ran. Exact freshness, renewal, account-switching and reinstall rules are maintained in the [mobile lifecycle guide](README.md#biometric-activation-and-access).

## Localization and appearance

`shared/i18n/messages.ts` holds matching Spanish/English catalogs and a pure language resolver. `device-language.ts` reads Expo Localization; `use-app-messages.ts` reacts to device/browser language changes and foreground return. The first supported preferred language wins, with Spanish as fallback. There is no in-app selector or stored language override.

Presentation uses localized copy, and the native credential adapter obtains the current localized prompt when invoking custody. Language changes do not reconstruct the authentication coordinator or alter tokens and device bindings. OS-owned prompts and WorkOS hosted pages retain their respective localization ownership; details are in the [language guide](README.md#device-language).

`src/theme` supplies colors and spacing. The welcome screen owns its decorative, noninteractive geometric background and action layout. Those visuals are excluded from touch/accessibility navigation and have no role in authentication decisions. Follow the [UI sources](../ui-style.md) when extending the channel.

## Configuration boundaries

- `EXPO_PUBLIC_API_BASE_URL` is public, bundled configuration. The composition root selects the base; the HTTP adapter restricts the allowed environment/provider pairing. Changing `.env` does not authorize an arbitrary host.
- `.env.example` is a committed template; actual `.env` files are ignored. `eas.json` is shared build configuration, not credential custody. Environment values and commands remain in the [development guide](README.md#connecting-native-login).
- Native plugins, supported languages, identifiers and startup background belong to `app.json`. Native dependency/configuration changes require a new binary; Metro reload only replaces JavaScript.
- Metro and USB forwarding are development infrastructure. A debug build needs a reachable development server; a white window caused by an unavailable server is not proof of a session or backend failure.

## Verification and extension

The [testing guide](../../testing.md) defines the evidence expected at each boundary:

- [`mobile-channel-authentication.test.ts`](../../../tests/mobile-channel-authentication.test.ts): coordinator behavior, callback validation, HTTP boundaries and public SDK behavior with synthetic dependencies.
- [`mobile-biometric-authentication.test.ts`](../../../tests/mobile-biometric-authentication.test.ts): credential custody, installation/account isolation, biometric/lifecycle recovery and revocation invariants through injected dependencies.
- [`mobile-localization.test.ts`](../../../tests/mobile-localization.test.ts): preference ordering, fallback, catalog completeness and native language metadata.
- [`mobile.consumer.test.ts`](../../../tests/pact/mobile.consumer.test.ts): the real mobile HTTP caller and its generated consumer contract; provider verification is separate from physical-device behavior.

Unit/contract tests, TypeScript and web export do not establish native biometric security, callback return, lifecycle behavior or iOS permission localization. Real-device validation is required for those changes. The repository's backend architecture checker does not by itself prove mobile dependency-boundary compliance.

When adding a real feature, keep its routes thin, place UI/application/domain/adapters under its capability as needed, inject external dependencies at composition, and add relevant tests and channel/module documentation. Reuse shared code only for concrete cross-feature needs; do not create placeholder layers or advertise unimplemented business flows.
