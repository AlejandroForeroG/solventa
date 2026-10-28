# Acquisition & Risk

Code: `backend/acquisition-risk`. This module owns quotes, pricing, profiling, rating, underwriting, offers and asynchronous refresh of authorized signals. Issuance and collection belong to Policy; authorization and consent belong to Identity.

## Implemented state

Worker with its own `acquisition` schema, runtime role and Hyperdrive. `/health` indicates liveness. RPC diagnostics protected by web check SQL and communication with Identity. Base tables exist. The anonymous indicative calculator (`POST /api/v1/quote-estimates`) and minimum-data quote (`POST /api/v1/quotes`) are implemented. Signal providers are isolated behind their port with two interchangeable simulated adapters, and an ACORD Life inspired translator maps partner quote messages to the quote model; see [external integrations](#external-integrations). Synthetic mortgage offer profiling consumes `ReadSignal`: it saves successful reads, replaces a failing source with a same-consent stored copy or conservative default, and persists degraded decisions as non-acceptable preliminary offers. Definitive offer acceptance and asynchronous publication remain under the explicit financial mock mode. Real provider access, dynamic simulated personas and general asynchronous signal refresh remain pending.

## Anonymous indicative calculator

An estimate gateway outage returns 503 without any write. It can be retried as a new calculation, without an idempotency key; saved-quote write recovery instructions apply only to the authenticated quote entries.

The HTTP adapter parses the media type with `node:util`'s `MIMEType` and requires the exact `application/json` essence, allowing normal parameters such as `charset=utf-8`. Prefix look-alikes and combined media types are rejected with 400.

`POST /api/v1/quote-estimates` is public, documented in Quotes OpenAPI 1.2.1 with `security: []`. It accepts exactly `{ ageYears, amount, termMonths }`: safe integers, ages 18–70, positive integer COP amount and terms 12–240 months. The JSON body is limited to 1024 bytes, including chunked requests; unsupported properties, types, ranges, invalid JSON and non-JSON media types return 400 without echoing values or unknown keys. Successful calculations return 200 with premium, currency, amount, term, basis, rule version and a correlation UUID. Responses use `Cache-Control: no-store`. The web version gate precedes forwarding and preserves its headers, including on a normalized binding failure (503).

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

## Profiled synthetic offers

The existing calculator and saved minimum-data quote remain preliminary. Creating an offer does not change their meaning. The explicit academic offer rule runs only with `FINANCIAL_PROVIDER_MODE=mock`, an environment-specific `FINANCIAL_EVENT_KEY` of exactly 64 lowercase hexadecimal characters, and local/dev/staging. Production and missing configuration fail closed. The simulated sources are external adapters; ownership, current consent, underwriting, persistence, historical capture and idempotency execute in Solventa. These offers do not establish approved actuarial terms or real insurance coverage.

| Route | Web operation and behavior |
|---|---|
| `POST /api/v1/quotes/{quoteId}/offers` | `offers:create`: accepts `{}` and an idempotency key. Identity verifies all four current risk-profiling scopes in the same private RPC as web authentication. The owner reads only the user's saved quote and evaluates the configured simulated provider through `ReadSignal`. All-live inputs may produce a definitive offer; any substituted source produces a preliminary offer. |
| `POST /api/v1/offers` | `offers:create-flight`: accepts only `{ "product": "flight_delay", "flightReference": "<synthetic UUID>" }`. This product reads no financial signals and needs no risk-data consent. Its fixed, versioned academic rule supplies premium, payout, threshold and validity. |
| `GET /api/v1/offers/{offerId}` | `offers:read`: reads an integrity-checked offer owned by the authenticated user. Foreign and absent resources both return 404. |
| `POST /api/v1/offers/{offerId}/accept` | `offers:accept`: accepts `{}` and an idempotency key. The persisted product determines whether current risk consent is mandatory. A client cannot select another product or operation to bypass mortgage consent. A successful 202 stores acceptance, audit and signed outbox together; delivery and policy creation are asynchronous. |

Writes require the configured same-origin Origin and sealed web cookie, JSON up to 1024 bytes, and an `Idempotency-Key` of 1–128 visible ASCII characters. Caller-selected amounts, owner IDs, approval, coverage and unknown keys are rejected. Public offer responses omit `clientId` and `subjectToken`; errors contain only a canonical code and correlation UUID. Headers are no-store and correlated. Native sessions and partner tokens do not authorize these web-only operations. All paths retain the gateway version gate.

The immutable offer carries its premium, coverage, effective dates, expiry and rule version. A degraded decision records each source, failure, substitute and confidence and persists the offer as `preliminary`; reads and idempotent replays return it, while both application and SQL acceptance guards refuse it. Acceptance of a definitive offer rechecks integrity, ownership, expiry and applicable consent. The publisher validates the signed canonical payload, claims bounded leases, publishes with a stable event ID and marks publication only after Queue confirmation. At-least-once delivery permits duplicate messages; Policy's inbox prevents duplicate owner effects. Exhausted/permanently invalid records remain observable rather than being silently discarded. There is no synchronous Acquisition-to-Policy call on the critical path.

Definitive offer creation writes its underwriting decision, offer, immutable revision, sealed context, audit, outbox and request ledger in one compound SQL statement using the database's implicit transaction. No separate BEGIN/COMMIT round trips are needed for that single statement; any failed insert rolls back the whole graph. This reduces SQL round trips without changing ownership, provider calls, replay/conflict rules or the durable delivery path. HTTP/event contracts and migrations are unchanged.

Before any provider call, creation reads one owner-local snapshot with a single fixed, parameterized `UNION ALL` statement: the actor's request-ledger outcome for the idempotency key, the actor's keyed offer context, and, only for a new mortgage request with no recorded outcome or keyed context, the actor's completed quote. Recorded and legacy replays do not decode the mutable live quote. Flight creation passes no quote reference and reads no quote. Nothing is cached; every request reads fresh rows. The use case keeps the previous order of decisions: a recorded ledger outcome (offer or decline) always wins; otherwise a keyed context created before the ledger replays only if its seal, owner and request identity match; a changed product, quote or flight under the same key is a conflict; an absent or foreign quote returns 404; an expired quote returns `expired` before any provider read. Insert-race winners after a uniqueness conflict are resolved with the same snapshot on the failed statement's connection.

Acceptance reads the owned offer context and the actor's prior acceptance for the key in one fresh statement. Ownership, sealed integrity and current mortgage consent are still verified before a prior acceptance can replay. The existing transaction then locks the offer row, rechecks persisted status/seal and expiry, and rechecks the persisted expiry, sealed expiry and authorization deadline against `clock_timestamp()` after the lock. Only then does one CTE insert the acceptance with `ON CONFLICT DO NOTHING` and select its success audit and signed outbox row from the inserted acceptance, so a conflicting or replayed key cannot create audit or events. The adapter commits only when the statement reports exactly one acceptance, one audit and one event; a no-op rolls back and resolves replay/conflict from the stored acceptance, and any other count or error rolls back. Serialization failures keep the existing bounded retry. The isolated SQL smoke withholds each required audit/outbox INSERT privilege and requires the entire offer graph or acceptance to roll back; no partial success is returned.

After acquiring the offer row lock, acceptance checks the database wall clock against the persisted expiry, sealed expiry and authorization deadline before any acceptance write. Transaction-start `now()` alone cannot reject authorization that expires during lock contention. The isolated SQL smoke holds the lock through expiry and requires zero acceptance, success-audit and accepted-event effects.

A newly committed acceptance schedules `waitUntil` publication targeted to its event ID. It uses the same durable outbox, bounded lease and stable Queue identity as the minute cron; unrelated backlog does not displace that event. Publication failure cannot turn an already committed acceptance into a false HTTP failure, and the cron retains recovery responsibility. The publisher is a module-level helper, not an exposed Service Binding RPC. Background execution and zero configured consumer batching wait reduce avoidable waiting but do not guarantee Queue delivery or an end-to-end latency percentile.

The explicit `academic-mortgage-1` rule requires verified identity, active affiliation, payment score at least 600 and monthly obligations no higher than 50% of monthly income. A score of at least 750 with obligations no higher than 30% applies a 10% discount to the existing provisional monthly premium. All calculations use integer units before the established four-decimal money representation. The offer expires within 15 minutes, capped by the quote and current consent expiry. Accepted and declined underwriting captures preserve the actual normalized source inputs/timestamps and rule version with the owner's audit/outbox; a decline does not create a definitive offer. The independent `academic-flight-1` fixture uses a verified mock schedule, a COP 10,000.0000 premium, COP 100,000.0000 indemnity at 180 minutes of delay and a one-day coverage window. These values are versioned academic fixtures, not source-approved commercial tariffs.

After acceptance, resolve the policy through the [Policy flow](../policy-claims-payments/README.md#financial-http-flow). The [offers OpenAPI](../../../packages/contracts/openapi/v1/offers.yaml), [event schema](../../../packages/contracts/schemas/financial-event.v1.json) and [synthetic examples](../../../packages/contracts/examples/financial.json) describe the boundaries. Example signatures are deliberately invalid and never authenticate a message. Additive offer migrations and runtime grants are prerequisites; resource/secret provisioning and a real browser/Queue/SQL acceptance check are separate from builds. Unit and HTTP checks run in `npm run test:financial`; SQL checks run in `npm run test:offers:sql`.

## External integrations

Mortgage offer profiling uses `SIGNAL_PROVIDER` through `ReadSignal`; flight offers retain the separate `MockFlightSchedule` fixture. The direct/aggregator translators produce the fields underwriting reads (`monthlyIncomeCop`, `monthlyObligationsCop`, `score`, `active`, `verified`). Neither the ACORD translator nor a standalone signal endpoint is public. No adapter here connects to a real signal, payment, signature or oracle provider.

Every external format is translated in an adapter; the domain, use cases and ports only see internal models. Replacing a provider changes an adapter and configuration, never `src/domain` or `src/application`. The shared rule and the integrations that are not implemented yet are in [architecture](../../architecture.md#external-integrations); the schemas and corpus are described in [contracts](../../shared/contracts/README.md#integration-schemas-and-corpus).

### Signal providers

`ReadSignal` (`src/application/read-signal.ts`) reads a signal through the `SignalProvider` port (`src/application/ports/signal-sources.ts`) after the [consent check](../identity-consent-ecosystem/consent.md#guard-in-acquisition). Two adapters implement the port:

| `SIGNAL_PROVIDER` | Adapter | External model (format version 1) |
|---|---|---|
| `direct_simulated` | `src/adapters/outbound/direct-signal-provider.ts` | Each source answers in its own format: Open Finance (Bancolombia) amounts in COP cents, Datacrédito Experian score, RUAF affiliations per subsystem, Registraduría document status |
| `aggregator_simulated` | `src/adapters/outbound/aggregator-signal-provider.ts` | One aggregator returns every source in a common envelope with its own state codes, amounts in whole pesos |

Both are **simulated**: their source returns fixed synthetic answers for one fictitious person and never reaches a real provider. They exist to keep the core independent of any provider format; a real provider adds a source (HTTP client) and an entry in `src/adapters/outbound/signal-providers.ts`, and the configuration value selects it.

**Static simulation limit.** The simulated sources are static: every subject receives the same answer, and the failure paths (`not_found`, `unavailable`, `timeout`…) are reached only in tests. They are now consumed by the synthetic mortgage offer flow, so environment verification proves the integration and degradation mechanics, not person-specific risk behavior or real provider access. Dynamic deterministic personas remain future work.

The direct and aggregator adapters produce the same signal for each scope (`SignalData` in `src/adapters/outbound/signal-provider-call.ts`):

| Scope | `data` |
|---|---|
| `income_obligations_12m` | `monthlyIncomeCop`, `monthlyObligationsCop` (whole pesos) |
| `payment_history_score` | `score` (0 to 1000), `latePayments12m` |
| `affiliation_regime` | `regime` (`contributory`, `subsidized` or `special`), `active` |
| `identity_validation` | `verified` |

`capturedAt` is the provider's cut-off as a UTC instant; a provider date without time is midnight in Bogotá. The simulated sources stamp every answer with the query time, so a consumer that requires a fresh signal accepts it. An impossible date or time, such as `2026-02-30` or `24:00`, is an `invalid_response`, never rolled over to another day. Unknown state codes (affiliation, document, aggregator state) are also `invalid_response`. DANE statistics are aggregated public data outside the consent and are not a signal scope.

**Failures.** Provider payloads are untrusted. Each adapter applies a 700 ms deadline, cancels the call when it expires and rejects only with `ProviderFailure`, whose code is one of:

| Code | Cause |
|---|---|
| `timeout` | No answer within the deadline |
| `unavailable` | 5xx, a transport error or a provider state reporting its own source failure |
| `rate_limited` | 429 |
| `unauthorized` | 401 or 403 |
| `not_found` | 404 or a provider state reporting no data for the subject |
| `invalid_response` | Any other status, or a body that does not match the provider format |

Before rejecting, the adapter logs one line, for example `{"event":"signal_provider_failed","traceId":"…","provider":"aggregator_simulated","scope":"payment_history_score","code":"not_found"}`. The subject token, the provider message and the payload are never logged. `ReadSignal` keeps the code in the degradation it reports; see [signal degradation](#signal-degradation).

**Configuration.** `SIGNAL_PROVIDER` is a variable in `backend/acquisition-risk/wrangler.jsonc`, read in the composition root and diagnostics. Every environment, prod included, uses `direct_simulated`, so signal data is synthetic everywhere. `infraStatus` is not ready and offer creation is disabled when the value is unknown. Changing provider is a one-line configuration change.

### Signal degradation

`ReadSignal` keeps a read useful when an external source fails. A standalone call checks consent first. Offer creation instead receives the one current four-scope authorization already verified by its web boundary, preventing four duplicate Identity calls while preserving the same consent ID/version/expiry. It then reads each provider with a hard limit of 700 ms (`SIGNAL_DEADLINE_MS`, shared with the adapters; the use case repeats the limit so a provider that ignores it cannot hold the read). A successful read is saved for at most two minutes and never beyond consent expiry. When the read fails it replaces the source, in this order:

1. A stored copy, only if it was captured under the same valid consent and its `validUntil` has not passed. Looking it up has its own 700 ms limit: a store that does not answer in time counts as no copy, so the default is never held back.
2. A conservative default for that scope.

The result is `degraded` and carries `degradation: { scope, failure, substitute, confidence }`. `failure` is the `ProviderFailure` code; any other error counts as `unavailable`. A consent denial never reaches a copy or a default: it stays `denied`. `executeAll` reads the four scopes in parallel, so one failing source does not delay or block the others, and returns the four results with an overall `confidence`.

| Origin of the signal | Confidence |
|---|---|
| Live read | 100 |
| Stored copy | 60 |
| Default | 0 |

The overall confidence is the rounded average of the four levels, and a denied source counts as 0. If Datacrédito fails and there is no copy, the other three stay live and the overall confidence is 75; with a valid copy it is 90.

A default never favors the customer. Each one makes the mortgage underwriting rule reject, and a test replaces every live source by its default to prove it:

| Scope | Default `data` | Why the rule rejects it |
|---|---|---|
| `income_obligations_12m` | `monthlyIncomeCop` 1, `monthlyObligationsCop` 1 | Obligations are 100 % of income, over the 50 % limit |
| `payment_history_score` | `score` 0, `latePayments12m` 12 | Score under 600 |
| `affiliation_regime` | `regime` `contributory`, `active` false | Not an active affiliation (`regime` is mandatory in the shape and means nothing when `active` is false) |
| `identity_validation` | `verified` false | Identity not verified |

The values, the confidence levels and the order above are versioned as `degradation-1` (`DEGRADATION_VERSION`). Every substitution writes one line that names the version and carries no subject token, provider message or payload:

```json
{"event":"signal_degraded","traceId":"…","rule":"degradation-1","scope":"payment_history_score","failure":"timeout","substitute":"default","confidence":0}
```

`SqlSignalSnapshots` stores successful reads append-only in `risk_profiles`. Migration `0011_risk_profile_consent_reference.sql` preserves legacy UUID consent IDs and adds the public `CNS-*` reference used by Identity. A snapshot is eligible only under that exact consent and before its validity ends. Storage is a cache: the Worker keeps its bounded write alive in `waitUntil`, outside the response critical path, and a failed snapshot write does not discard a live provider answer.

Mortgage offer creation consumes `executeAllAuthorized`. Any degraded source makes the decision and persisted offer `preliminary`, with `degraded: true`, normalized failure, substitute and confidence in the immutable capture. Preliminary offers can be read and replayed but cannot emit `offer.accepted` or reach Policy. All-live sources retain the existing definitive/declined business rule.

The grouped creation statement preserves the decision outcome, offer status and created-event status together with its revision, sealed context, audit and idempotency ledger. Acceptance uses the fresh owner snapshot and rejects preliminary terms before any acceptance write. The composition root retains both bounded background snapshot persistence and targeted publication after a committed definitive acceptance.

Every mortgage offer creation request logs one `mortgage_offer_profiled` record with only its trace, normalized final result, offer status, handler latency in milliseconds and the time of each dependency it called. This includes authorization denials, Identity deadlines and SQL failures; a failed security denial audit is recorded as `unavailable`, matching the final HTTP response. An authorization denial is a successful Identity call with a denied result; an RPC rejection or deadline is a failed call. Identity timing includes its caller-observed deadline, even if the RPC never settles. Use these records to calculate backend latency and dependency percentiles in the target environment. The 400 ms p95 / 800 ms p99 journey objective also requires measurement through the deployed web path; no actor, quote, consent or provider payload is logged.

```json
{"event":"mortgage_offer_profiled","traceId":"…","result":"created","offerStatus":"definitive","latencyMs":61,"dominant":"offer_write","dependencies":[{"name":"identity_access","durationMs":9,"outcome":"ok"},{"name":"offer_read","durationMs":8,"outcome":"ok"},{"name":"provider:payment_history_score","durationMs":0,"outcome":"ok"},{"name":"offer_write","durationMs":31,"outcome":"ok"}]}
```

Each entry is one call, timed by `DependencyTimings` from the injected clock, and `outcome` is `ok` or `failed`. The names are `identity_access` (authorization in Identity), `offer_read` and `offer_write` (the offer SQL reads and the grouped creation statement), `provider:<scope>` for each of the four source reads and `stored_copy:<scope>` for a copy lookup, which only happens after a provider fails. `dominant` is the single slowest call of the request, including a failed one. Background snapshot writes are not part of the response and are not timed. [`infra/load/dependencies.mjs`](../../../infra/load/dependencies.mjs) turns a backend log into the table of calls, errors, p50, p95 and p99 per dependency; see the [load guide](../../../infra/load/README.md).

**Latency budget per external call.** Each provider read and each stored copy lookup has a budget of 120 ms (`SIGNAL_BUDGET_MS`) inside the 700 ms hard limit. The budget is measured, not enforced: a call that takes more than 120 ms but less than 700 ms still answers live, and only the hard limit degrades a source. A call that exceeds the budget, whether it answers or fails, writes one line from the injected clock, with no subject token, provider message or payload:

```json
{"event":"dependency_budget_exceeded","traceId":"…","budgetMs":120,"dependency":"provider","scope":"payment_history_score","durationMs":300,"outcome":"ok"}
```

`dependency` is `provider` or `stored_copy` and `outcome` is `ok` or `failed`. A call that reaches 700 ms writes both this line and `signal_degraded`. Identity authorization and the offer SQL calls cannot be replaced by a default, so they are outside this budget.

**Limits.**
- The 120 ms budget line is written only for provider and stored copy calls that exceed it. Identity and the offer SQL are timed in `mortgage_offer_profiled` but have no budget. Only the offer creation route records timings; offer reads, acceptance and the flight offer do not.
- The percentiles per dependency come from a log file the caller provides. No dashboard or metrics service reads them yet.
- The 400 ms p95 / 800 ms p99 profile-and-price objective requires measurement through the deployed web, Identity, provider and SQL path; unit tests establish parallel reads and the 700 ms per-dependency ceiling, not the percentile objective.
- The minimum-data quote and the calculator call no external provider, so nothing degrades there. A provider added to either must use this degradation: hard limit, stored copy or conservative default, and a trace with source, substitute and confidence.

### ACORD Life inspired quote messages

`src/adapters/inbound/acord-life-quote.ts` translates a partner's quote request in Solventa's ACORD Life inspired format to the internal `QuoteRequest`, and a quote result back to an ACORD response. This is a synthetic subset with its own versioned schemas, not the licensed ACORD standard.

| Function | Direction |
|---|---|
| `readAcordQuoteRequest(message)` | ACORD request to the `CreateQuote` body. It checks the envelope only: `schemaVersion` `1`, `TransType` `QuoteRequest`, currency `COP` and product `MORTGAGE_LIFE`. A missing envelope field is `required`; another value is `unsupported_version`, `unsupported_transaction`, `unsupported_currency` or `unsupported_product`. Unknown properties are ignored |
| `acordFieldErrors(errors)` | Domain validation errors with the ACORD path the partner sent, for example `credit.amount` to `TXLifeRequest.Holding.Loan.LoanAmt` |
| `writeAcordQuoteResponse(result)` | A created or replayed quote to an ACORD response |
| `writeAcordFailure(errors, traceId)` | Rejection reasons to an ACORD response, with paths and codes but never the submitted values |

| ACORD field | Internal field |
|---|---|
| `Party.FullName`, `GovtIDTC`, `GovtID`, `BirthDate`, `City` | `customer.fullName`, `documentType`, `documentNumber`, `birthDate`, `city` |
| `Holding.Policy.ProductCode` `MORTGAGE_LIFE` | `product` `vida_hipotecario` |
| `Holding.Loan.LoanNumber`, `LoanAmt`, `LoanTermMonths` | `credit.partnerCreditId`, `amount`, `termMonths` |

Field rules (age, formats, amount and term ranges) stay in `src/domain/quote.ts`. The translator is not mounted on a route: a partner endpoint for ACORD needs its OpenAPI specification, contract tests and versioning, and must use the partner channel (`POST /api/v1/quotes` credentials), never the web session.

**Verification.**

```sh
npm run test:integrations   # both provider corpora, failures and logs, deadline, configuration, a core that names no provider, and the ACORD corpus
```

## Documents

- [Data, historical capture and offer revisions](data.md).
- [Contracts and decision capture](../../shared/contracts/README.md).
- [Boundaries and communication](../../architecture.md).
- [Operations](../../infrastructure/README.md).

When implementing module endpoints/decisions, follow [common standards](../../endpoint-standards.md), [purposeful testing](../../testing.md) and [migration procedures](../../infrastructure/migrations.md). Document specific behavior here without copying shared rules.
