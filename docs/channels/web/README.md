# Web

Code: `apps/web`. Run commands from the repository root.

React, Vite and TypeScript. Start with `npm run dev:web`. The channel includes entry, session checking and logout; business flows are pending.

Credentials are entered in WorkOS AuthKit. Web accesses Identity through a Service Binding and does not receive tokens. See [authentication](../../modules/identity-consent-ecosystem/authentication.md) to start the complete local flow at `http://localhost:8787`.

The Worker applies API versioning to `/api/v<N>/...`: it adds deprecation headers and returns 410 when a version reaches its retirement date. See [contracts](../../shared/contracts/README.md).

The SPA reaches `/auth/*` through `src/api/auth.ts`. Its calls are protected by a Pact contract with the web Worker; changing them requires updating the pact ([consumer contracts](../../shared/contracts/README.md#consumer-contracts-pact)).

Logo and favicon come from `packages/assets`; preserve the green identity and loading, error and session states when extending the UI.
