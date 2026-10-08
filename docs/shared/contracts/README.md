# Contracts

Code: `packages/contracts`. Spec, schema and type paths are relative to that package; run commands from the repository root.

Stable boundary contracts: public API versioning, OpenAPI specifications and schemas for data crossing boundaries. This package contains no shared domain entities, services or rules. A backend core (`domain`/`application`) cannot import it; adapters, the web Worker and tests consume it.

## Published API reference

The public, read-only Scalar viewer is served by the web Worker at `/api/docs/`:

| Environment | API reference |
|---|---|
| Dev | [OpenAPI viewer](https://solventa-web-dev.ja-forerog1.workers.dev/api/docs/) |
| Staging | [OpenAPI viewer](https://solventa-web-staging.ja-forerog1.workers.dev/api/docs/) |
| Prod | [OpenAPI viewer](https://solventa-web-prod.ja-forerog1.workers.dev/api/docs/) |
| Local | [OpenAPI viewer](http://localhost:8787/api/docs/) after building web and starting the local Workers |

Select a domain/version to inspect its operations, parameters, request/response schemas, examples and security requirements. The responsive reference includes sidebar navigation, search and request/response examples alongside operations. The `spec` query parameter preserves the selected domain/version when reloading or sharing operation links, for example `/api/docs/?spec=v1/quotes`. **OpenAPI JSON** opens the selected bundled specification; `/api/docs/catalog.json` lists available specifications. The viewer identifies its current environment. Relative `servers` URLs refer to that same environment.

The web build runs `tools/build-api-docs.mjs` after Vite. It discovers every `packages/contracts/openapi/v<N>/*.yaml` specification containing paths, resolves its shared references with Redocly and emits JSON, a catalog and locally hosted Scalar assets under `apps/web/dist/api/docs/`. Component-only files such as `common.yaml` remain dependencies of domain specifications. Generated output is ignored; YAML is the single contract source. Adding a domain/version needs no handwritten viewer entry. Every CI build and environment Deploy regenerates the reference from the exact revision being deployed; each environment shows its own deployed revision, not a live copy of dev or GitHub.

The viewer and JSON require no login and contain only public contracts with synthetic examples. `GET` and `HEAD` are supported; writes to documentation paths return 405. Missing JSON/script assets return 404 instead of the product SPA. Documentation responses use `Cache-Control: no-store` so a new deployment is visible after reloading. Scripts and brand assets are hosted on the same origin; CDN fonts, telemetry, agent features and the embedded API client/test requests are disabled. A same-origin content security policy also restricts network requests. Use the existing [API access guide](../../modules/identity-consent-ecosystem/api-access.md) and Bruno collection for authorized requests. This viewer does not bypass API authentication or authorization.

The reference uses Solventa's green UI palette, warm neutral navigation, rounded example cards and semantic method/code colors, as explicitly requested for this viewer. Other technical documents retain their monochrome convention. Desktop navigation stays fixed below the measured header, with its own scroll area independent of document height; narrow screens use Scalar's collapsible navigation. The header offset updates when controls wrap or browser zoom changes, and no empty internal header row is reserved on desktop. Selecting another domain navigates to its query URL without an operation hash, loading a fresh reference at the top and clearing pending lazy-navigation scroll state. Verify the first load, short/long domain switches (including a switch immediately after navigating to Schemas), bottom-of-document navigation, mobile menu and keyboard focus when changing this layout.

The web test suite executes the viewer loader against its HTML in a DOM harness. It checks both domain-switch directions from a Schemas URL, navigation without the old hash, loading the selected contract in a fresh reference, and preserving shared operation links. These tests cover the navigation handoff; the real browser checks above remain necessary to verify Scalar's lazy rendering and visual layout.

IBM Plex Sans (400/500/600/700) and Mono (400/600) are bundled from the shared [font assets](../assets/README.md) and loaded from `/api/docs/fonts/` using `@font-face` with `font-display: swap`. The same-origin font files and their `/api/docs/fonts/LICENSE.txt` use the same read-only, no-store and missing-asset protections as other documentation assets. The generator tests verify every CSS font reference is a bundled WOFF2 file with its license, and route tests cover GET/HEAD, rejected writes and SPA fallback. Verify the browser reports both families loaded and that header/sidebar alignment still holds after loading; do not infer an available font from its CSS family declaration alone.

## Maintaining API documentation

Every API addition, change or removal must update its OpenAPI domain specification, affected examples/contract tests and the owning module's technical guide **in the same branch and PR as the implementation**. Document parameters, validation, request/response schemas, status/error codes, authentication/scopes and applicable deprecation notices. Follow the versioning rules below for compatibility. Use synthetic examples; never include tokens, cookies, credentials or personal data.

Before integrating, run `npm run test:contracts`, `npm run lint:openapi` and `npm run check`, then inspect the generated viewer and JSON for the changed domain in dev. Promote the same tested base through the [Gitflow](../../infrastructure/ci-cd.md), and verify the reference in staging/prod after their Deploy succeeds. A generated viewer keeps published YAML current with deployment; it cannot detect every mismatch between implementation and an outdated specification. The author and reviewer must compare the changed endpoint behavior against its contract and tests.

No remote configuration, SQL migration or secret is required for this viewer. Building web is sufficient to generate it:

```sh
npm run build --workspace @solventa/web
npm run dev:backend
```

For the local stack setup, use [development](../../development.md) and [infrastructure operations](../../infrastructure/README.md). Vite's API proxy forwards documentation requests to the local web Worker, which serves the built reference.

| Path | Content |
|---|---|
| `openapi/v<N>/<domain>.yaml` | Independent, valid OpenAPI spec per domain (quotes, consent…) inside its version directory |
| `openapi/v<N>/common.yaml` | Shared version components (`X-Trace-Id`, `Error`, deprecation headers); domain specs reference them with `$ref` |
| `openapi/v1/quotes.yaml` | Minimum-data quote for partners (`POST /quotes`) and web users (`POST /me/quotes`): responses 201, 200, 400, 401, 403, 409 and 503; access errors carry only the canonical code and the trace id |
| `examples/quotes.json` | Valid and invalid cases with synthetic data, checked against the spec by `tests/quotes-contract.test.ts` |
| `src/versions.ts` | Version registry (`apiVersions`) with optional `deprecatedAt` and `sunset` |
| `schemas/decision-capture.v1.json` | Schema of data stored with each quote/decision to reconstruct it |
| `redocly.yaml` | OpenAPI lint rules |

## API versioning

The version lives in the path: `/api/v1/...`. A compatible change (new optional field/endpoint) stays in the current version and increments `info.version` (1.0.0 → 1.1.0). An incompatible change (removing/renaming a field, changing its type, requiring a previously optional field, tightening validation or changing a status code's meaning) requires a new version. Versions coexist: each has its own inbound adapter translating to the same use case.

**A version is never retired without a retirement date.** Without `sunset`, it is indefinite and carries no notices. With `sunset` (`YYYY-MM-DD`, Bogotá time, beginning at 00:00 -05:00):

| Time | Web Worker response |
|---|---|
| Before `sunset` | The version responds and adds `Deprecation: @<deprecatedAt epoch>`, `Sunset: <HTTP date>` and, if a successor exists, `Link: <equivalent path>; rel="successor-version"` |
| From `sunset` | 410 `{ "error": "version_retired" }` with the same `Link` |

The gate lives in `apps/web/worker/api-versions.ts` and applies to every `/api/v<N>/...` route; backends do not repeat it.

### One spec per domain

Each domain has its own file (`openapi/v1/quotes.yaml`, `openapi/v1/consents.yaml`…), so stories affecting different domains do not edit the same file. Each spec is complete OpenAPI, with `info.version` starting with its version number and `servers[0].url` equal to `/api/v<N>`. Reference shared components with `$ref`, for example `$ref: './common.yaml#/components/schemas/Error'`. Specs belong directly in their version directory, with no extra subdirectories or loose files in `openapi/`.

To add a domain, create `openapi/v<N>/<domain>.yaml` and, if needed, mount its routes in the owning backend and route its prefix in the web Worker. Write descriptions, summaries and identifiers in English.

### Publishing a new version

1. Create `openapi/v<N+1>/` with specs for domains changing incompatibly (`info.version` `<N+1>.0.0`, `servers[0].url` `/api/v<N+1>`) and `common.yaml`. Unchanged domains may be reused through `$ref` to `v<N>`.
2. Add `{ id: 'v<N+1>' }` to `apiVersions`.
3. Mount `/api/v<N+1>` routes in the owning backend and route the prefix in the web Worker.

### Retiring a version

Set its `deprecatedAt` and `sunset` in `apiVersions`; in **every** spec in its directory, set `info.x-sunset` to the same date and `deprecated: true` on every operation. Tests check registry/spec agreement and prevent deprecated operations in a version without a retirement date. Archive retired-version contracts in the same change.

## Lint and tests

```sh
npm run lint:openapi     # Redocly checks all .yaml files in openapi/
npm run test:contracts   # Versioning, registry/spec agreement and capture schema
```

Both run in `npm run check` (CI and deployment). `pre-commit` runs lint for changes in `openapi/` or `redocly.yaml`; `pre-push` always runs it. Hooks can be bypassed, so CI is the blocking control. `no-unused-components` is disabled while no endpoint references common components; reenable it with the first endpoints. Each operation must declare `operationId`, `summary`, `security` (`security: []` if public) and at least one 4xx response.

## Historical capture

`decision-capture.v1.json` specifies what persists with each decision: schema/API contract version, `correlationId`, normalized inputs without PII, consulted sources with timestamp/quality, consent state (`verified` with identifier/version, `not_required` or `absent`), rule/model versions and outcome. It evolves only through optional fields; incompatible changes create `decision-capture.v2.json`. It fits existing JSON columns (`input_snapshot`, `explanation`, `normalized_request`); the API contract version goes in `contract_version`.

Per-decision capture creation, persistence and routing with headers are explained in [endpoint standards](../../endpoint-standards.md).

## TypeScript types from OpenAPI (pending)

Types are not generated yet. Once endpoints exist, use `openapi-typescript` on each `openapi/v<N>/<domain>.yaml` spec to write `src/generated/v<N>.d.ts`, add a package `generate` script (as in `@solventa/assets`), commit sources/generated files together and make CI regenerate and fail on differences.
