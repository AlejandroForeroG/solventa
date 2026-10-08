# Endpoints and business decisions

Apply this guide when implementing a new business route and subsequent changes. Module code and docs evolve together. Examples explain the pattern; they neither create an endpoint nor establish implemented quoting, Pact or event publication.

## Historical capture of each decision

[decision-capture.v1.json](../packages/contracts/schemas/decision-capture.v1.json) defines the common capture. Create **one instance containing the data used for each decision**, rather than schema-file copies per endpoint. A request making several decisions can produce several captures with the same `correlationId`; a query making no decision need not invent one.

| Field | Preserve |
|---|---|
| `schemaVersion` | `1` for this schema |
| `contractVersion` | Incoming version, for example `v1` |
| `correlationId` | Request UUID matching the schema pattern |
| `inputs` | Minimal normalized inputs actually used, without PII or secrets |
| `sources` | Consulted sources, `capturedAt` and quality/degradation when applicable; `[]` if none |
| `consent` | `verified` with `id` and `version`, `not_required` or `absent`, according to actual authorization |
| `rule` | Applied rule identifier and version |
| `model` | Model identifier and version, if used |
| `outcome` | Result from the use case's vocabulary |

Example: a future `POST /api/v1/quotes` receives `{ "amount": 320000000 }` and produces an illustrative premium of 86,400. The actual calculation/rule require implementation; this amount does not define an approved formula.

```ts
const capture = {
  schemaVersion: 1,
  contractVersion: 'v1',
  correlationId: '11111111-1111-4111-8111-111111111111',
  inputs: { amount: 320000000 },
  sources: [],
  consent: { status: 'not_required' },
  rule: { id: 'quote-rating', version: '2026.1' },
  outcome: 'quoted',
};
```

Persist the quote, historical capture, applicable audit and outbox in Acquisition's transaction. A `save` call satisfies this only if its adapter actually commits them together. If commit fails, return no success and promise no durable audit. Do not store the capture only in logs or another owner's table.

Six months later, the capture must explain the input amount, `quote-rating` version `2026.1` and its sources/consent even when the current version is `2026.2`. Also preserve required inputs or immutable references and the historical rule/model artifact: a version name alone cannot reproduce a deleted rule. Do not reconstruct an old offer from its mutable projection. See [Acquisition data](modules/acquisition-risk/data.md).

`not_required` is a use-case conclusion, not a shortcut around consent. `absent` enables neither a provider nor fallback. An archived consent version explains the past but does not authorize future use: check current validity in Identity before querying, applying or reusing signals. Generate the capture in the use case with its own types; validate its representation against the shared schema at the boundary/adapter or in tests, without importing `packages/contracts` into the core.

## Endpoint dependencies

The HTTP factory receives its ports/use cases. It does not construct SQL, WorkOS or other Workers inside a handler. The adapter transforms and validates input; Application orchestrates and Domain decides. Keep routes thin.

```ts
import { Hono } from 'hono';

type QuoteUseCase = {
  execute(input: unknown): Promise<{ id: string; premium: string }>;
};

export function createHttp(deps: { quotes: QuoteUseCase }) {
  const app = new Hono();
  app.post('/api/v1/quotes', async c => {
    const quote = await deps.quotes.execute(await c.req.json());
    return c.json(quote, 201);
  });
  return app;
}
```

The signature is illustrative; define the validated DTO and actual contract errors. In the `src/index.ts` composition root, construct `SqlQuoteRepository`, Identity adapters and the use case, then inject the use case into `createHttp`. HTTP/contract tests inject a use case with in-memory repositories/adapters and can run without Docker. SQL adapter tests are a separate layer. Do not refactor `/auth/*` as part of adding these routes.

## Public routing and version headers

The gate lives in [apps/web/worker/index.ts](../apps/web/worker/index.ts), using [gateApiVersion and withHeaders](../apps/web/worker/api-versions.ts). When mounting a route, change where its response comes from and keep `withHeaders(response, gate.headers)` as the final step. Resolve `gate.response` first so a retired version never invokes a backend.

```ts
if (path.startsWith('/api/')) {
  const gate = gateApiVersion(path, new Date(), apiVersions);
  if (gate.response) return gate.response;

  const quotesPath = path === '/api/v1/quotes'
    || path.startsWith('/api/v1/quotes/');
  const response = quotesPath
    ? await env.ACQUISITION.fetch(request)
    : Response.json({ error: 'not_implemented' }, { status: 404, headers });

  return withHeaders(response, gate.headers);
}
```

Apply the same pattern with `env.IDENTITY.fetch(request)` or `env.POLICY.fetch(request)` for their owners' routes. Avoid `return env.<binding>.fetch(request)` bypassing headers. Preserve headers on normalized error responses; unexpected binding failures need translation to a safe technical response before that final step. Do not accidentally route `/quotes-other` as `/quotes`.

Before retirement, a version with `sunset` retains `Deprecation`, `Sunset` and `Link` where applicable. At retirement it returns 410. A version without a retirement date adds no such notices. See [contracts and versioning](shared/contracts/README.md) for formats and coordinated registry/spec changes.

## Validation

Use [purposeful tests](testing.md). For the implemented capability, cover calculations/rules and boundaries, actual consent, schema-compliant captures and version preservation, joint persistence, idempotency with a different payload, and errors without partial success. HTTP tests check invalid input, denied access and contractual output with in-memory dependencies; web Worker tests check headers on successes/errors and zero backend calls after retirement.

Domain OpenAPI specs, module guides and tests change with behavior. The PR links those guides. Documenting examples does not replace implementation or its tests.
