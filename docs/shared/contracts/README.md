# Contracts

Code: `packages/contracts`. Spec, schema and type paths are relative to that package; run commands from the repository root.

Stable boundary contracts: public API versioning, OpenAPI specifications and schemas for data crossing boundaries. This package contains no shared domain entities, services or rules. A backend core (`domain`/`application`) cannot import it; adapters, the web Worker and tests consume it.

| Path | Content |
|---|---|
| `openapi/v<N>/<domain>.yaml` | Independent, valid OpenAPI spec per domain (quotes, consent…) inside its version directory |
| `openapi/v<N>/common.yaml` | Shared version components (`X-Trace-Id`, `Error`, deprecation headers); domain specs reference them with `$ref` |
| `openapi/v1/quotes.yaml` | Minimum-data quote for partners (`POST /quotes`) and web users (`POST /me/quotes`): responses 201, 200, 400, 401, 403, 409 and 503; access errors carry only the canonical code and the trace id |
| `examples/quotes.json` | Valid and invalid cases with synthetic data, checked against the spec by `tests/quotes-contract.test.ts` |
| `openapi/v1/consents.yaml` | Consent of the authenticated web user: terms, grant, decline, list and revoke; responses 200, 201, 204, 400, 401, 403, 404, 409 and 503, with only the canonical code and the trace id in errors |
| `examples/consents.json` | Terms and consents in each status with synthetic data, checked against the spec by `tests/consents-contract.test.ts` |
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
