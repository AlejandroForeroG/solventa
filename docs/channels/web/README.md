# Web

Code: `apps/web`. Run commands from the repository root.

React, Vite and TypeScript. Start with `npm run dev:web`. The channel includes entry, session checking, logout and the quote journey (form and result); other business flows are pending.

Credentials are entered in WorkOS AuthKit. Web accesses Identity through a Service Binding and does not receive tokens. See [authentication](../../modules/identity-consent-ecosystem/authentication.md) to start the complete local flow at `http://localhost:8787`.

The Worker applies API versioning to `/api/v<N>/...`: it adds deprecation headers and returns 410 when a version reaches its retirement date. See [contracts](../../shared/contracts/README.md).

The same Worker serves the public, read-only OpenAPI viewer at `/api/docs/` and bundled specifications beneath that path, independently of the React application and business service bindings. Web builds generate its assets from the current domain contracts. See [published API reference and maintenance](../../shared/contracts/README.md#published-api-reference) for environment URLs, local setup and the requirement to update API documentation with every endpoint change.

Logo and favicon come from `packages/assets`; preserve the green identity and loading, error and session states when extending the UI.

## Quote journey

`src/quote/` holds the form, the result and the access-denied screen; `src/i18n/` holds the es-CO and en-US catalogues (react-intl) and the switcher, which changes language without reloading. Amounts are always shown in COP. A single `aria-live` region announces state changes, and focus moves to the first invalid field or to the step heading.

The browser calls `POST /api/v1/me/quotes` with the sealed session cookie of the same origin; it holds no key or token. If the answer is 401 the client renews the session through `/auth/session` and retries the same request once, with the same idempotency key. A session that cannot be renewed sends the user back to sign in; 403 shows the access-denied screen and 503 a service-unavailable message. See [API access](../../modules/identity-consent-ecosystem/api-access.md).

The result shows the quote's validity as "valid until" the date in the response's `validUntil`, formatted in the `America/Bogota` time zone; the client never assumes a fixed validity period and omits the validity when the response has no parseable date. The button that continues to data authorization stays disabled until that step exists. The stepper is an ordered list that marks the current step with `aria-current="step"`; it contains no controls and adds no tab stops.

Styles follow the approved Design System values in `src/index.css`: IBM Plex Sans for text, Space Grotesk for headings and IBM Plex Mono for labels, identifiers and amounts, loaded from Google Fonts through `index.html` with system fallbacks. Every link, button and field shows the same keyboard focus ring (3 px, brand green, 2 px offset). Hover colours apply only to the element's own variant, and long trace identifiers wrap on narrow screens.

## Consent and privacy dashboard

`src/consent/` holds step 3 of the journey, the safe exit and the privacy dashboard. The contract is [consents.yaml](../../shared/contracts/README.md) and the rules are in [Consent](../../modules/identity-consent-ecosystem/consent.md). The browser calls `/api/v1/consents` with the same session cookie and the same renewal rule as the quote, through `src/session-fetch.ts`.

- **Step 3** loads the terms from `GET /api/v1/consents/terms` and shows the purpose, the sources with their type and the validity before anything can be authorized. "Authorize and continue" stays disabled until the mandatory checkbox is marked. Authorizing sends only the text version the customer saw and the quote reference; a retry reuses the same `Idempotency-Key`. If the text changed meanwhile, the terms are reloaded and the checkbox is cleared.
- **Safe exit** follows "I do not authorize": it keeps the minimum-data estimate and states that no offer, policy or charge follows. A refusal never depends on the audit write succeeding.
- **Privacy dashboard** opens from the header button, lists each authorization with its id, status, period, sources, scope and seal, and revokes an active one after an inline confirmation. A failed revocation leaves the authorization active and says so. Going back keeps what was typed in the quote.
- Source names and types come from the catalogues by code; an unknown code falls back to the code itself. Dates use the `America/Bogota` time zone.

After authorizing, the screen confirms the authorization and links to the dashboard. The personalized offer is a later step: the stepper keeps steps 4 to 7 locked.

```sh
npm run test:web          # vitest: screens, languages, accessibility (axe) and API client
```
