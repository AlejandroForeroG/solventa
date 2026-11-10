# Parametric payouts

Code: `backend/policy-claims-payments`. A parametric policy pays a fixed indemnity when a verified external occurrence reaches the threshold of its own coverage, with no claim from the customer and no manual approval. Two variants exist: flight delay and heavy rainfall. Both share one payment engine, `PolicyFinance.applyOccurrence`; only the coverage rule differs. The provider is simulated: Solventa's rules, authorization, SQL, audit, outbox and idempotency run for real, and no real flight or weather service is contacted.

## Variants

| | Flight delay | Heavy rainfall |
|---|---|---|
| Product and coverage kind | `flight_delay` | `weather_event` |
| Insured reference | `flightReference` | `stationId` |
| Parameter and unit | delay, minutes | `precipitation_24h`, `mm` |
| Threshold | 180 | 50 |
| Indemnity | COP `100000.0000`, once per policy | COP `100000.0000`, once per policy |
| Rule version | `academic-flight-1` | `academic-weather-1` (required by the offer validation) |
| Occurrence | `flight.delay_verified` | `weather.precipitation_verified` |

These numbers are academic implementation rules, not values prescribed by the functional or architecture sources. The rainfall reading is the accumulated precipitation of the 24 hours that end at the observation time. The applicable period is the policy's coverage window.

An occurrence pays only when all of these hold: the policy is `issued` and passes its integrity check; the occurrence kind matches the coverage kind; it names the insured flight or station; its value reaches the threshold; and it happened at or after the keyed issuance time and inside the coverage window. A mortgage policy never owes an indemnity. Any other case is rejected with an audited `event_not_covered` and creates no claim, indemnity, payment or notice.

The weather product is not sold: Acquisition does not emit weather offers. A weather policy exists when a signed `offer.accepted` event for it reaches Policy, which goes through the same issuance, premium charge and signature as any other policy. That event is produced by tests and the simulated flow only.

## Entry points

- **Private RPC `receiveParametricEventV1`** on the Policy Worker. It accepts the simulated provider's format [`parametric-provider-event.v1`](../../../packages/contracts/schemas/parametric-provider-event.v1.json) and answers `{ status: 'ok', replayed, policyId, indemnity: { status: 'confirmed', reference } }` or a denied/unavailable result with the canonical code. It never returns the policy document or its hash. There is no public HTTP route for provider events.
- **Queue consumer** `consumeParametricEvent`, unchanged: a signed `flight.delay_verified` envelope of [financial-event.v1](../../../packages/contracts/schemas/financial-event.v1.json). Its stored fingerprint is not affected by this work.

Both reach the same core. The shared inbox consumer `policy.parametric.v1` is keyed by event identity.

## Provider adapter and contract

`MockParametricEventProvider` (`adapters/outbound/mock-parametric-provider.ts`) is the only place that knows the provider format. It requires the exact fields, the current environment, `synthetic: true`, an `observedAt` that is a UTC instant ending in `Z` with at most three fractional digits (the schema pattern and the adapter accept the same form, so an offset such as `+00:00` is rejected by both), integer values within their limits (delay up to 10080 minutes, rainfall up to 2000 mm) and a valid signature. The signature is an HMAC over a domain-separated content string, so it cannot validate as an offer or any other sealed message, and it uses the existing financial key: no new secret exists. Valid messages become a `ParametricOccurrence`; every other message is `invalid_event` (400) with an owner rejection audit and no effect.

The agreed corpus [parametric-provider-events.json](../../../packages/contracts/examples/parametric-provider-events.json) holds valid and negative cases and runs in `npm run check` through `tests/parametric-provider.test.ts`, which also checks that the schema and the adapter agree. A new field or a changed unit needs `parametric-provider-event.v2`.

## Identity, replay and conflict

The effect is one claim, indemnity and payment per policy (`parametric-once`). The inbox row stores the event fingerprint.

- The same event identity and content again is a replay: no second payment, notice or decision capture.
- The same identity with different content is `event_conflict`.
- A different event for a policy that already has its effect is `event_conflict`.
- A rejected occurrence, such as rain below the threshold, leaves no effect, so a later qualifying event is accepted.

## Confirmation and the customer notice

Provider settlement happens between owner transactions, as for premiums. A confirmed result runs one transaction that updates the payment, indemnity and claim, writes the `indemnity.confirmed` audit and decision capture, and inserts the outbox event `policy.indemnity.notice` (version 1). Its payload is `{ category: 'parametric_payment_confirmed', clientId, policyId, paymentId, coverageKind, confirmedAt }`. It names the policy owner, carries no amount, document or personal data, and uses the payment ID as its event ID, so a payment can be announced at most once.

An uncertain provider result throws before that transaction: the payment stays `pending`, the call answers `unavailable` and nothing is announced as paid. A declined result is terminal: one transaction stores the payment as `declined` and writes the `indemnity.declined` audit and decision capture, then the call answers `payment_declined`. It is never announced, a replay of the same event answers `payment_declined` without reaching the gateway again, and the recovery no longer selects it. The indemnity and claim keep their stored state because the schema has no declined state for them; the payment and its decision are the terminal record. Settlement is idempotent per payment in the provider, so a retry never pays twice.

Policy persists the notice, but no consumer delivers it yet: the push delivery, preferences and device permission belong to the notifications story. Until it adopts `policy.indemnity.notice`, no customer receives an alert.

## Recovery

A retry with the same event completes a pending payment. Without one, the Worker's `scheduled` handler also runs `PolicyFinance.reconcileIndemnities` once per minute after `reconcileIssuances`. It selects at most 25 indemnity payments that are still `pending` for more than two minutes and whose event was already accepted, refreshing their activity so batches rotate. For each, it settles the existing payment (a charge the provider already holds is only looked up), confirms it and creates the notice in the same transaction, with `trigger: 'reconciliation'` in the decision capture. The recovered decision repeats the measurement and the authenticated provider source stored in the `parametric.accepted` capture of that policy, read in the same query, so it explains the payout like the first attempt. It never creates a claim or a second effect. Each run logs `indemnity_reconciliation` with the trace, outcome (`confirmed`, `unchanged`, `rejected` or `unavailable`) and error code.

## Wallet exposure

`GET /api/v1/policies` can return a `weather_event` policy, so the [policy OpenAPI](../../../packages/contracts/openapi/v1/policies.yaml) lists the product and coverage and the [mobile wallet](../../channels/mobile/README.md#policy-wallet) decodes, stores and shows it.

## Verification and limits

`tests/parametric-payout.test.ts` runs both variants through the real use case with an in-memory owner: covered events, thresholds, other station or flight, wrong kind, mortgage policy, periods, forged or malformed messages, replay, conflict, uncertain, declined and recovered payments, and the notice. `npm run test:financial:sql` repeats the weather flow, the notice and the recovery on real SQL with the runtime grants.

Limits: the event names its policy, as the simulated oracle already did, so no lookup from flight or station to policies exists; the provider is simulated and signed with the financial key; the weather product cannot be bought; a mass event campaign and back-pressure are a separate technical story; and the notice is stored, not delivered.
