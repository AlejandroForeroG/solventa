# Acquisition & Risk

Code: `backend/acquisition-risk`. This module owns quotes, pricing, profiling, rating, underwriting, offers and asynchronous refresh of authorized signals. Issuance and collection belong to Policy; authorization and consent belong to Identity.

## Implemented state

Worker with its own `acquisition` schema, runtime role and Hyperdrive. `/health` indicates liveness. RPC diagnostics protected by web check SQL and communication with Identity. Base tables exist. The minimum-data quote (`POST /api/v1/quotes`) is implemented; profiling, Open Finance, fallback, offers and asynchronous refresh require implementation.

## Minimum-data quote

Contract: [`openapi/v1/quotes.yaml`](../../shared/contracts/README.md). The web Worker forwards `/api/v1/quotes` and `/api/v1/me/quotes` here through a Service Binding, after the version gate and without touching the credentials.

| Entry | Actor | Credential |
|---|---|---|
| `POST /api/v1/quotes` | Partner | `Authorization: Bearer <WorkOS M2M token>` |
| `POST /api/v1/me/quotes` | Authenticated web user | The sealed session cookie and the request `Origin`; an `Authorization` header is rejected with 400 |

Both entries run the same use case. Identity decides who the actor is through `authorizeApiAccessV1` ([API access](../identity-consent-ecosystem/api-access.md)); Acquisition never reads the user from the body.

| Layer | Code |
|---|---|
| Domain | `src/domain/quote.ts`: age on the Bogotá calendar, validation, the `provisional-1` premium rule and the decision capture |
| Application | `src/application/create-quote.ts` and the ports in `src/application/ports/` |
| Adapters | `quotes-http.ts` (HTTP), `identity-api-access.ts` (Identity RPC), `sql-quote-store.ts` (SQL), `hmac-protector.ts` |
| Composition | `src/index.ts`, which injects the use case into `createHttp({ quotes })` |

Each request runs in this order: credential, access check, `Idempotency-Key`, validation, calculation, write. Without a credential the answer is 401 and Identity is not called. Identity's answers keep their difference: 401 `unauthorized`, 403 `forbidden`, 503 `access_unavailable`; an RPC failure, a reply that does not validate or a call past the 2 s deadline blocks the quote as 503. A 400 names the field and the code, never the submitted value. Responses carry `X-Trace-Id` (UUID); the server generates one when the header is missing or invalid.

**Who owns a quote.** A partner quote belongs to the partner and is keyed by a keyed hash of the customer's document. A web quote belongs to the user's `clientId` and uses the user's own `subjectToken`; the document in the body is not stored. Idempotency is scoped to the actor, so one key used by two users creates two quotes.

**Premium rule.** Monthly premium = amount × rate ÷ 1,000,000, rounded half up to a whole peso. The rate depends on the completed age: 18-30, 220; 31-40, 270; 41-50, 400; 51-60, 650; 61-70, 1000 (parts per million). The term (12 to 240 months) does not change the premium. This is a placeholder, not an actuarial tariff: replace it by publishing a new `ruleVersion`.

**Configuration.** `QUOTE_HMAC_KEY` (at least 32 characters, different per environment) signs the document and the request. Locally, copy `.dev.vars.example` to `.dev.vars`. In dev, staging and prod the operator loads it as a Worker secret; without it an authorized request returns 500 and writes nothing. Apply migrations `0006_partner_quotes.sql` and `0007_user_quotes.sql` before deploying this code. Partner tokens need Identity's `WORKOS_CONNECT_*` configuration; until it exists, the partner entry answers 503.

**Verification.**

```sh
npm run test:quotes       # domain, use case, HTTP, Identity adapter and web Worker
npm run test:contracts    # includes the examples against the quotes spec
npm run test:quotes:sql   # real local SQL for both actors; requires npm run infra:up
```

The load test in [`infra/load`](../../../infra/load/README.md) needs a logged-in session cookie or a partner token.

**Limits.** The web journey after login and a real partner token have not been demonstrated end to end here; they depend on a WorkOS login and on the M2M setup that Identity documents. Each quote adds one Identity call to the critical path, so the earlier load measurements, taken before that call existed, must be repeated. The yearly quote-code counter is one shared row: it sustained about 190 writes per second locally, and a failed write leaves a gap in the numbering.

## Documents

- [Data, historical capture and offer revisions](data.md).
- [Contracts and decision capture](../../shared/contracts/README.md).
- [Boundaries and communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
