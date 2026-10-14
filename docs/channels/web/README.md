# Web

Code: `apps/web`. Run commands from the repository root.

React, Vite and TypeScript. Start with `npm run dev:web`. The channel includes entry, session checking, logout, the minimum-data quote journey, consent and the privacy dashboard; later business flows are pending.

Credentials are entered in WorkOS AuthKit. Web accesses Identity through a Service Binding and does not receive tokens. See [authentication](../../modules/identity-consent-ecosystem/authentication.md) to start the complete local flow at `http://localhost:8787`.

The Worker applies API versioning to `/api/v<N>/...`: it adds deprecation headers and returns 410 when a version reaches its retirement date. See [contracts](../../shared/contracts/README.md).

The SPA reaches `/auth/*` through `src/api/auth.ts`. Its calls are protected by a Pact contract with the web Worker; changing them requires updating the pact ([consumer contracts](../../shared/contracts/README.md#consumer-contracts-pact)).

The same Worker serves the public, read-only OpenAPI viewer at `/api/docs/` and bundled specifications beneath that path, independently of the React application and business service bindings. Web builds generate its assets from the current domain contracts. See [published API reference and maintenance](../../shared/contracts/README.md#published-api-reference) for environment URLs, local setup and the requirement to update API documentation with every endpoint change.

Logo and favicon come from `packages/assets`; preserve the green identity and loading, error and session states when extending the UI.

## Quote journey

`src/quote/` holds the form, the result and the access-denied screen; `src/i18n/` holds the es-CO and en-US catalogues (react-intl) and the switcher, which changes language without reloading. Amounts are always shown in COP. A single `aria-live` region announces state changes, and focus moves to the first invalid field or to the step heading.

The browser calls `POST /api/v1/me/quotes` with the sealed session cookie of the same origin; it holds no key or token. If the answer is 401 the client renews the session through `/auth/session` and retries the same request once, with the same idempotency key. A session that cannot be renewed sends the user back to sign in; 403 shows the access-denied screen and 503 a service-unavailable message. See [API access](../../modules/identity-consent-ecosystem/api-access.md).

The client validates successful responses before displaying a quote: its identifier, integer COP amounts, term, timestamp, minimum-data basis, rule version and trace identifier must match the supported contract. Malformed results and field errors produce the unavailable state without losing the form or changing the retry key. The result shows "valid until" the response's `validUntil`, formatted in the `America/Bogota` time zone; the client never assumes a fixed validity period. The result continues to data authorization. The stepper is an ordered list that marks the current step with `aria-current="step"`; it contains no controls and adds no tab stops.

Styles follow the approved Design System values in `src/index.css`: IBM Plex Sans for text, Space Grotesk for headings and IBM Plex Mono for labels, identifiers and amounts, loaded from Google Fonts through `index.html` with system fallbacks. Every link, button and field shows the same keyboard focus ring (3 px, brand green, 2 px offset). Hover colours apply only to the element's own variant, and long trace identifiers wrap on narrow screens.

## Consent and privacy dashboard

`src/consent/` holds step 3 of the journey, the safe exit and the privacy dashboard. The contract is [consents.yaml](../../shared/contracts/README.md) and the rules are in [Consent](../../modules/identity-consent-ecosystem/consent.md). The browser calls `/api/v1/consents` with the same session cookie and the same renewal rule as the quote, through `src/session-fetch.ts`. Its calls are protected by a Pact contract with the web Worker; changing them requires updating the pact ([consumer contracts](../../shared/contracts/README.md#consumer-contracts-pact)).

- **Step 3** loads the terms from `GET /api/v1/consents/terms` and shows the purpose, the sources with their type and the validity before anything can be authorized. "Authorize and continue" stays disabled until the mandatory checkbox is marked. Authorizing sends the text version this screen supports (`SUPPORTED_TEXT_VERSION`), the language of the interface and the quote reference; if Identity serves another version, the screen offers no authorization and asks to reload, and a grant for a version Identity no longer serves is refused. A retry reuses the same `Idempotency-Key` unless the language changes. If the text changed meanwhile, the terms are reloaded and the checkbox is cleared.
- **Safe exit** follows "I do not authorize": it keeps the minimum-data estimate and states that no offer, policy or charge follows. It advances only after the refusal is recorded; a failed audit write offers a retry.
- **Privacy dashboard** opens from the header button, lists each authorization with its id, status, period, sources, scope and seal, and revokes an active one after an inline confirmation. Navigation and repeated actions stay disabled through the write and its reconciliation, including a language change. If the response is lost or unavailable, the client cannot infer whether the write committed: it reloads the current page and offers a retry when the record is still active, without claiming that revocation necessarily failed. If the reload also fails, the list's unavailable state offers another read. Returning keeps the quote's form and shows an unconfirmed state instead of cached active authorization until a confirmed write or a subsequent read contains that same consent. An omitted pagination item does not confirm its state. Reads started before the write finished, or cancelled reads, cannot clear that uncertainty. Leaving the panel through logout cancels its read and prevents late write responses from starting another reconciliation or restoring the private flow.
- Source names and types come from the catalogues by code; an unknown code falls back to the code itself. Dates use the `America/Bogota` time zone.
- Completion announcements after a pending revocation or reconciliation use the currently selected interface language. Changing language does not restart that write or its reconciliation read.

After authorizing, the screen confirms the authorization and links to the dashboard. An idempotent replay can return an already revoked or expired record; the confirmation and live announcement show that status instead of announcing active authorization. Observations for the same immutable grant cannot regress to active: revoked takes precedence over expired, which takes precedence over active, including when a delayed page response arrives after revocation. This client state never grants permission to use a source; the backend verifies consent afresh. The result describes only the minimum-data calculation and the next consent decision; no source query or personalized pricing is implemented by these screens. The personalized offer is a later step: the stepper keeps steps 4 to 7 locked.

```sh
npm run test:web          # vitest: screens, languages, accessibility (axe) and API client
```
