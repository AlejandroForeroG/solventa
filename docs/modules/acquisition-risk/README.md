# Acquisition & Risk

Code: `backend/acquisition-risk`. This module owns quotes, pricing, profiling, rating, underwriting, offers and asynchronous refresh of authorized signals. Issuance and collection belong to Policy; authorization and consent belong to Identity.

## Implemented state

Worker with its own `acquisition` schema, runtime role and Hyperdrive. `/health` indicates liveness. RPC diagnostics protected by web check SQL and communication with Identity. Base tables exist. The anonymous indicative calculator (`POST /api/v1/quote-estimates`) and minimum-data quote (`POST /api/v1/quotes`) are implemented; profiling, Open Finance, fallback, offers and asynchronous refresh require implementation.

## Anonymous indicative calculator

An estimate gateway outage returns 503 without any write. It can be retried as a new calculation, without an idempotency key; saved-quote write recovery instructions apply only to the authenticated quote entries.

The HTTP adapter parses the media type with `node:util`'s `MIMEType` and requires the exact `application/json` essence, allowing normal parameters such as `charset=utf-8`. Prefix look-alikes and combined media types are rejected with 400.

`POST /api/v1/quote-estimates` is public, documented in Quotes OpenAPI 1.2.0 with `security: []`. It accepts exactly `{ ageYears, amount, termMonths }`: safe integers, ages 18–70, positive integer COP amount and terms 12–240 months. The JSON body is limited to 1024 bytes, including chunked requests; unsupported properties, types, ranges, invalid JSON and non-JSON media types return 400 without echoing values or unknown keys. Successful calculations return 200 with premium, currency, amount, term, basis, rule version and a correlation UUID. Responses use `Cache-Control: no-store`. The web version gate precedes forwarding and preserves its headers, including on a normalized binding failure (503).

`EstimateQuote` validates through its own domain input and calls the same `monthlyPremium` and `RULE_VERSION` as `CreateQuote`; the browser does not reproduce the rate table. The calculator has no Identity, SQL, HMAC, source or messaging dependency. It produces no saved quote, identifier, validity, business decision capture, audit or outbox: this is a nonbinding arithmetic preview, not underwriting, an offer or a contractual decision. Actual quote creation remains authenticated, independently validated/recalculated and transactionally captured. It does not accept an estimate identifier, saved browser price or client-supplied actor. No migrations, grants, secrets or provider configuration are added.

The [web journey](../../channels/web/README.md#anonymous-estimate-and-sign-in) explains the account handoff and temporary input retention. Existing partner/web quote access, actor-scoped idempotency, ownership and consent protections remain unchanged. `tests/quote-estimates.test.ts` checks rating boundaries, bounded/redacted input, actual public gateway routing and no access/store calls; the SPA consumer pact covers success, validation and outage. These checks do not establish load limits or production abuse resistance.

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

Each HTTP request runs in this order: channel credential, access check, `Idempotency-Key`, validation, calculation, write. Missing or malformed credentials still produce a channel-specific Identity check with an empty token or cookie. The outbound adapter also replaces tokens over 8192 characters and cookies over 16384 characters with empty values; an Origin over 256 characters becomes an unconfigured empty origin. Identity then records its canonical 401/403 denial without receiving oversized values. Required-record failure returns 503 and blocks the quote. Identity's answers keep their difference: 401 `unauthorized`, 403 `forbidden`, 503 `access_unavailable`; an unexpected RPC 400, a reply that does not validate, a failed call or one past the 2 s deadline is an integration failure and returns 503. A quote-validation 400 names a known field or container and the code, never the submitted value or an unknown property name. Unknown properties use `customer`, `credit` or an empty field for the request root. Responses carry a lowercase `X-Trace-Id` UUID with version 1 through 8 and RFC variant; missing or invalid headers receive a generated UUID before Identity is called.

The Identity access-check input includes the initiating trace UUID, shared by the HTTP response and security denial. Covered 401/403 decisions commit a minimal security audit/outbox in Identity before the denial returns. Acquisition does not duplicate this security record or read Identity tables. Direct in-process use of `CreateQuote` with a null credential still returns 401 without calling Identity; the public HTTP adapter always supplies the channel-specific attempt. See [security recording scope](../../security.md#durable-rejection-records).

A gateway failure returns 503 `service_unavailable` and preserves a valid caller-supplied trace ID. The gateway may lose a response after Acquisition commits the quote, so a 503 does not prove that no quote was stored. An internal quote failure returns 500 `internal_error`. After either error, retry only with the same `Idempotency-Key` and unchanged request body to recover a confirmed result without creating another quote.

**Body limit.** A body over 16 KiB is answered as a validation error (400) after the access check. It is refused from `Content-Length` before reading, or cancelled while reading when no length is declared, so it is never held in memory.

**Who owns a quote.** A partner quote belongs to the partner and is keyed by a keyed hash of the customer's document. A web quote belongs to the user's `clientId` and uses the user's own `subjectToken`; the document in the body is not stored. Idempotency is scoped to the actor, so one key used by two users creates two quotes.

**Premium rule.** Monthly premium = amount × rate ÷ 1,000,000, rounded half up to a whole peso. The rate depends on the completed age: 18-30, 220; 31-40, 270; 41-50, 400; 51-60, 650; 61-70, 1000 (parts per million). The term (12 to 240 months) does not change the premium. This is a placeholder, not an actuarial tariff: replace it by publishing a new `ruleVersion`.

**Configuration.** `QUOTE_HMAC_KEY` (at least 32 characters, different per environment) signs the document and the request. Locally, copy `.dev.vars.example` to `.dev.vars`. In dev, staging and prod the operator loads it as a Worker secret; without it an authorized request returns 500 and writes nothing. Apply migrations `0006_partner_quotes.sql`, `0007_user_quotes.sql` and `0008_quote_idempotency_by_actor.sql` before deploying this code. Partner tokens need Identity's `WORKOS_CONNECT_*` configuration; until it exists, the partner entry answers 503.

The operator keeps an environment-specific, ignored `infra/.local/acquisition.<environment>.secrets.json` containing only `QUOTE_HMAC_KEY`. After verifying its length and environment, upload it to the matching Acquisition Worker with the installed Wrangler version:

```sh
node node_modules/wrangler/bin/wrangler.js secret bulk infra/.local/acquisition.dev.secrets.json --config backend/acquisition-risk/wrangler.jsonc --env dev --profile solventa-universidad
node node_modules/wrangler/bin/wrangler.js secret list --config backend/acquisition-risk/wrangler.jsonc --env dev --profile solventa-universidad
```

Replace `dev` consistently when preparing staging or prod. `secret bulk` publishes a new Worker version, so perform it as a coordinated environment operation before the quote PR is merged. The second command lists names only; confirm that `QUOTE_HMAC_KEY` is present without displaying its value. Subsequent Wrangler deployments preserve an existing secret. The local file belongs in authorized custody and never in Git or a request body. See [migration operations](../../infrastructure/migrations.md) for the separate SQL prerequisite.

**Verification.**

```sh
npm run test:quotes       # domain, use case, HTTP, Identity adapter and web Worker
npm run test:contracts    # includes the examples against the quotes spec
npm run test:quotes:sql   # real local SQL for both actors; requires npm run infra:up
```

The load test in [`infra/load`](../../../infra/load/README.md) needs a logged-in session cookie or a partner token.

**Limits.** Authenticated browser and M2M quote journeys require separate environment verification; local stand-ins, contracts and builds do not establish real provider access. For M2M, verify valid creation/replay, changed-payload conflicts and denied revoked or out-of-scope credentials, checking that rejected requests create no quote or quote audit/outbox in Acquisition. Covered Identity denials do create their separate security audit/outbox. Use dedicated synthetic credentials and revoke them after verification; never alter another operator's integration credential. Each quote adds one Identity call to the critical path, so performance must be measured through the complete authenticated path. The yearly quote-code counter is one shared row: it sustained about 190 writes per second locally, and a failed write leaves a gap in the numbering.

`ReadSignal` forwards the initiating trace UUID through the consent check before reaching a provider or stored signal. Its correlation, rejection and fallback rules are described in [Identity's Acquisition guard](../identity-consent-ecosystem/consent.md#guard-in-acquisition). This internal use case does not add a public signal endpoint.

## Definitive synthetic offers

The existing calculator and saved minimum-data quote remain preliminary. Creating an offer does not change their meaning. The explicit academic offer rule runs only with `FINANCIAL_PROVIDER_MODE=mock`, an environment-specific `FINANCIAL_EVENT_KEY` of exactly 64 lowercase hexadecimal characters, and local/dev/staging. Production and missing configuration fail closed. The simulated sources are external adapters; ownership, current consent, underwriting, persistence, historical capture and idempotency execute in Solventa. These offers do not establish approved actuarial terms or real insurance coverage.

| Route | Web operation and behavior |
|---|---|
| `POST /api/v1/quotes/{quoteId}/offers` | `offers:create`: accepts `{}` and an idempotency key. Identity verifies all four current risk-profiling scopes in the same private RPC as web authentication. The owner reads only the user's saved quote and evaluates deterministic mock data. |
| `POST /api/v1/offers` | `offers:create-flight`: accepts only `{ "product": "flight_delay", "flightReference": "<synthetic UUID>" }`. This product reads no financial signals and needs no risk-data consent. Its fixed, versioned academic rule supplies premium, payout, threshold and validity. |
| `GET /api/v1/offers/{offerId}` | `offers:read`: reads an integrity-checked offer owned by the authenticated user. Foreign and absent resources both return 404. |
| `POST /api/v1/offers/{offerId}/accept` | `offers:accept`: accepts `{}` and an idempotency key. The persisted product determines whether current risk consent is mandatory. A client cannot select another product or operation to bypass mortgage consent. A successful 202 stores acceptance, audit and signed outbox together; delivery and policy creation are asynchronous. |

Writes require the configured same-origin Origin and sealed web cookie, JSON up to 1024 bytes, and an `Idempotency-Key` of 1–128 visible ASCII characters. Caller-selected amounts, owner IDs, approval, coverage and unknown keys are rejected. Public offer responses omit `clientId` and `subjectToken`; errors contain only a canonical code and correlation UUID. Headers are no-store and correlated. Native sessions and partner tokens do not authorize these web-only operations. All paths retain the gateway version gate.

The immutable offer carries its premium, coverage, effective dates, expiry and rule version. Acceptance rechecks integrity, ownership, expiry and applicable consent; it never turns a preliminary quote or a degraded source result into a contract. The publisher validates the signed canonical payload, claims bounded leases, publishes with a stable event ID and marks publication only after Queue confirmation. At-least-once delivery permits duplicate messages; Policy's inbox prevents duplicate owner effects. Exhausted/permanently invalid records remain observable rather than being silently discarded. There is no synchronous Acquisition-to-Policy call on the critical path.

The explicit `academic-mortgage-1` rule requires verified identity, active affiliation, payment score at least 600 and monthly obligations no higher than 50% of monthly income. A score of at least 750 with obligations no higher than 30% applies a 10% discount to the existing provisional monthly premium. All calculations use integer units before the established four-decimal money representation. The offer expires within 15 minutes, capped by the quote and current consent expiry. Accepted and declined underwriting captures preserve the actual normalized source inputs/timestamps and rule version with the owner's audit/outbox; a decline does not create a definitive offer. The independent `academic-flight-1` fixture uses a verified mock schedule, a COP 10,000.0000 premium, COP 100,000.0000 indemnity at 180 minutes of delay and a one-day coverage window. These values are versioned academic fixtures, not source-approved commercial tariffs.

After acceptance, resolve the policy through the [Policy flow](../policy-claims-payments/README.md#financial-http-flow). The [offers OpenAPI](../../../packages/contracts/openapi/v1/offers.yaml), [event schema](../../../packages/contracts/schemas/financial-event.v1.json) and [synthetic examples](../../../packages/contracts/examples/financial.json) describe the boundaries. Example signatures are deliberately invalid and never authenticate a message. Additive offer migrations and runtime grants are prerequisites; resource/secret provisioning and a real browser/Queue/SQL acceptance check are separate from builds. Unit and HTTP checks run in `npm run test:financial`; SQL checks run in `npm run test:offers:sql`.

## Documents

- [Data, historical capture and offer revisions](data.md).
- [Contracts and decision capture](../../shared/contracts/README.md).
- [Boundaries and communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
