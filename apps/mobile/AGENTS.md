This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Product documentation

Follow the mandatory documentation rules in the root [AGENTS.md](../../AGENTS.md#required-documentation). Update the existing [mobile guide](../../docs/channels/mobile/README.md) in the same branch and PR for every feature or change to documented behavior. Link to the owning backend module for shared rules and contracts.

## Data stored on the device

Read the [protected local data guide](../../docs/channels/mobile/README.md#protected-local-data) and its [architecture rules](../../docs/channels/mobile/architecture.md#policy-wallet-and-protected-local-data) before storing anything on the phone.

- Business data may rest on the device only through `src/features/policy-cache` (or a feature built the same way). Never use `AsyncStorage`, plain files, logs, URLs or persisted React state for it.
- Store the minimum: project the source object field by field, validate each value and drop everything else. Documents, hashes, payment data, trace ids, provider flags, holder name and document number stay on the server. A new stored field needs its validation, a test, a size check and a documented reason.
- Use SecureStore with `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` and a key of its own. If native custody or a device screen lock is missing, store nothing; there is no unprotected fallback. Every opening of the data goes through `ProtectedPolicyCache.unlock()`, the system prompt that accepts biometrics or the device code, and `lock()` runs when the screen closes or the app is backgrounded. Do not claim the prompt is cryptographic: it is enforced by the app.
- Bind each record to the installation UUID and to the pseudonymous owner, and discard it when either differs. Reuse `src/shared/native` (`installationMarker`, `strongBiometricsAvailable`) instead of copying that logic.
- Clear local data when logout starts, when credentials are discarded, when the environment changes and when a different account is confirmed. `Authentication` receives the store through its `policyCache` dependency; a new store joins that clearing path, not a parallel one. Clear local data before removing the credential record that triggers the clearing, so a failed deletion is retried. Cancelling a new login must not clear data of the current owner.
- Do not trust a SecureStore delete or write to report failure: verify a removal by reading the key back and treat a failed removal as a failed sign-out step so it is retried.
- SecureStore values are small (about 2048 bytes on some iOS releases). Do not raise the policy limits; for larger data keep a key in SecureStore and encrypt a private file, as described in the guide, with the same rules.
- Cached data is stored data: show its sync date, keep it visibly apart from online data and never let it enable contracting, payment or any action the server must authorize.
- Tests with mocked Expo modules do not prove native protection. Say so, and list the device checks from the guide that were not run.

## Policy wallet

- The wallet (`src/features/policy-wallet`, route `/wallet`) shows only what Solventa has: the products `vida_hipotecario` and `flight_delay`, their sealed premium, validity and coverage. Mockups are illustrative; do not invent products, deductibles, holder names, contacts or documents the backend does not return. When a design needs a field that does not exist, show nothing, document the gap and ask for the data owner.
- The server is the source of truth. Online data is shown as current; the stored copy is shown only when the request fails for a network or server reason, with its own sync date and a visible banner. After an authentication failure or a malformed or incompatible answer never show the copy, and reject any policy the list route should not return (status other than `issued`).
- Offline the wallet must remain usable: a session that cannot be verified because the server is unreachable (`blocked` with `unavailable`) may open only the last stored copy behind device authentication, without calling the server. Never gate the stored copy on remote permissions or bypass a known revocation. `Authentication` first persists a revocation-only `logout` record, then clears the cache before deleting credentials or contacting the server; failed cleanup stays `logoutPending`, including after an offline restart when the cache's own discard note failed. Keep the cache's independent pending-removal guard too. See the mobile architecture guide for the limit when every native persistence path fails.
- Never read the clock while rendering (`Date.now()`, `new Date()`): the lint rule `react-hooks` rejects impure calls during render. Take time from the `useNow` hook (state refreshed every minute, so validity follows the clock while the screen stays open), and run `npm run lint --workspace @solventa/mobile`, which `npm run check` does not include. Only a 5xx, a rate limit or a network failure counts as an outage; a `409` integrity rejection and any other 4xx are failures, not reasons to show the copy.
- Read policies only through `GET /api/v1/policies` with the user access token (`createPoliciesApi`). A native client may read, never buy, accept or issue: those stay web-only. A new native call to Policy needs its operation allowed in Identity (`mobileUserOperations`), its OpenAPI contract, a Pact interaction and an ownership test.
- Keep screens thin: state and rules live in `PolicyWallet` and the domain, not in the component. Every state needs copy in both catalogs (`walletMessages` must keep identical keys) and accessible labels; check them on a device.
