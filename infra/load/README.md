# Quote and offer load tests

Measures the latency of `POST /api/v1/quotes` with [k6](https://k6.io) against the quality scenario: **p95 ≤ 250 ms and p99 ≤ 500 ms**. Synthetic data only.

`offers.k6.js` measures the complete HTTP request for `POST /api/v1/quotes/{quoteId}/offers` against the offer-profile objective: **p95 < 400 ms and p99 < 800 ms**. It measures the edge-to-response duration seen by the caller, including authentication, profile retrieval, external-signal deadlines, pricing, persistence and serialization. It never adds internal percentiles.

## What it measures and what it does not

It runs against the local Workers (`npm run dev:backend`) and the local Docker CockroachDB. Identity verifies every request, so you need a credential: the sealed session cookie of a logged-in user, or a partner M2M token.

**It does not show that production meets the objective.** The traffic skips the Cloudflare network and Hyperdrive, the database is a single node and the machine shares CPU with k6 and Docker. Use it to find code bottlenecks and to compare before and after a change. Identity accepts a real partner M2M token in dev and staging; measuring quotes there additionally requires the quote code deployed, Acquisition migrations `0006`–`0008` applied and `QUOTE_HMAC_KEY` loaded. Production needs its own partner setup and approved release.

## Running it

From the repository root, with Docker running:

```sh
npm run infra:up
npm run build --workspace @solventa/web
npm run dev:backend                  # Workers on http://localhost:8787
```

Sign in at `http://localhost:8787`, copy the value of the `solventa-session` cookie from the browser and pass it for this run only; never commit it:

```sh
COOKIE=<cookie value> sh infra/load/run.sh 30 60s    # POST /api/v1/me/quotes
TOKEN=<partner access token> sh infra/load/run.sh 30 60s    # POST /api/v1/quotes
```

`run.sh [rate] [duration] [url]` runs k6 in Docker, saves the full summary to `results/run-<rate>rps-<duration>.json` and prints the key numbers (`report.mjs`).

To measure offer profiling, create a quote through the web flow, then pass its code and the same session cookie:

```sh
COOKIE=<cookie value> QUOTE_ID=COT-2026-00001 sh infra/load/run-offers.sh 10 60s
```

`run-offers.sh` writes `results/offers-<rate>rps-<duration>.json`. Every virtual user uses a fresh idempotency key and replays one in ten requests. Checks require the public Offer contract, trace correlation and the expected `201`/`200` create/replay statuses. The run fails if p95 reaches 400 ms, p99 reaches 800 ms, or failures exceed 1%. A preliminary response is valid and counted separately; it must not be discarded by the measurement.

Local results are development evidence only. A staging run must use a staging-owned synthetic user and quote, and its summary must be attached separately; do not present a local result as staging evidence.

The 2026-10-22 local authenticated offer check used a constant arrival rate of 10 requests/s for 60 seconds: 600 requests, zero failures, 157 ms average, 246 ms p95, 347 ms p99 and 487 ms maximum. It exercised fresh and idempotent offer creation through the complete local web, Identity, provider and SQL path. This particular summary came from the local Node arrival-rate runner because the session credential was deliberately kept out of the Docker command boundary; it is not a k6 or staging result. The sanitized JSON summary is retained with the internal story evidence rather than committed.

The scenario warms up for 10 s at a low rate, then measures at a constant arrival rate. Each request uses a new `Idempotency-Key`, and one in ten repeats the previous request to exercise idempotency (it must answer 200 with the same quote). Checks cover the status, the `COT-YYYY-NNNNN` code, the COP currency and the `X-Trace-Id` header. k6 thresholds fail when p95 ≥ 250 ms, p99 ≥ 500 ms or more than 1 % of requests fail.

For dev diagnosis, Acquisition emits a structured `quote_sql_slow` log when one SQL store attempt takes at least 250 ms. It includes the trace ID, outcome and elapsed milliseconds for connection, the combined atomic lookup/counter/quote/audit/outbox statement (`save`), a race lookup when needed, and close. It does not log credentials or request data. Correlate these stages with Workers wall time and the k6 summary before changing the quote-code allocator; the log is disabled outside dev.

## Offer profiling (local evidence)

The 2026-10-26 local run of offer profiling was driven from the browser, not by `offers.k6.js`: the web session cookie is HttpOnly, so a page script is the only runner that can use it without handling its value. A page script sent `fetch` requests from the signed-in tab at a constant arrival rate of 10 requests/s for 60 s after a 10 s warm-up at 2 requests/s, against `POST /api/v1/quotes/{quoteId}/offers` with a fresh `Idempotency-Key` on each request and one in ten repeated. The time runs from sending the request to reading the whole body in the browser, which is close to but not the same as `http_req_duration`. It measured 600 requests: zero failures, 80 ms average, 71 ms median, 107 ms p90, 153 ms p95, 245 ms p99 and 319 ms maximum, against the 400 ms p95 and 800 ms p99 objective. All 600 returned the Offer contract and an `X-Trace-Id`; 540 were fresh `201` and 60 were replayed `200`, all `definitive`. It ran with the simulated providers on the local Workers and database, after the 120 ms call budget was added: the backend wrote no `dependency_budget_exceeded` and no `signal_degraded` line, so no call went over budget and no source was replaced. It is not a k6, remote or staging result, and it does not measure each dependency apart.

To see which dependency dominates, after a run that creates offers, save the backend output to a file and read it with `dependencies.mjs`. Each offer logs the time of every call it made, and the script reports the calls, errors, p50, p95 and p99 of each dependency, how many offers each one dominated and the end-to-end percentiles:

```sh
npm run dev:backend | tee offers-backend.log
node infra/load/dependencies.mjs offers-backend.log
```

The names and what each one measures are in the [Acquisition guide](../../docs/modules/acquisition-risk/README.md#signal-degradation). The log only contains offers created after the instrumentation was deployed, and a log from another environment must be attached as that environment's evidence, not as a local one.

A second local run, after offers began logging the time of each dependency, produced the table below with `node infra/load/dependencies.mjs` over the backend log of that run (620 profiled offers, the 600 measured plus the 20 of the warm-up). The browser slowed its timers in the first two attempts, which sent only 241 requests instead of 600 and were discarded, so this run's page script sends every request that is due by the clock whenever its timer wakes. Arrivals therefore come in small groups at an average of 10 requests/s, and the browser-side figures are higher than the backend's because requests queue behind each other: browser-side 600 requests, zero failures, 157 ms average, 158 ms median, 278 ms p95, 371 ms p99 and 584 ms maximum. In this pattern a few same-key requests overlapped, so 14 fresh requests answered `200` and 14 repeated ones `201`; every response still carried the Offer contract, a trace ID and `definitive` status.

| Dependency | Calls | Errors | p50 ms | p95 ms | p99 ms | Slowest call in |
|---|---|---|---|---|---|---|
| `identity_access` | 620 | 0 | 41 | 71 | 99 | 462 offers |
| `offer_write` | 590 | 0 | 36 | 71 | 131 | 154 offers |
| `offer_read` | 620 | 0 | 18 | 34 | 43 | 4 offers |
| `provider:affiliation_regime` | 590 | 0 | 0 | 1 | 1 | 0 |
| `provider:identity_validation` | 590 | 0 | 0 | 1 | 1 | 0 |
| `provider:income_obligations_12m` | 590 | 0 | 0 | 1 | 1 | 0 |
| `provider:payment_history_score` | 590 | 0 | 0 | 1 | 1 | 0 |

The backend measured 94 ms median, 163 ms p95 and 213 ms p99 end to end, inside the 400 ms and 800 ms objective. Identity authorization dominated three of every four offers and the grouped offer write most of the rest. The four providers are simulated and answer instantly, so their rows show the instrumentation, not a real provider's latency. No call exceeded the 120 ms budget (no `dependency_budget_exceeded` line) and no source was replaced (no `signal_degraded` line). The provider and write rows have 590 calls because 30 of the 620 offers were replays answered from the stored result before any source was read. A local database and Workers run on one machine, so these percentiles say where the time goes, not what dev, staging or prod would measure.

## Baseline before the Identity access call (local, 60 s per load)

Measured when a local stand-in authenticated the request inside Acquisition. The Identity call now adds a hop to every quote, so repeat the test before comparing.

| Load | Requests | Average | p95 | p99 | Max | Failures | Thresholds |
|---|---|---|---|---|---|---|---|
| 30 req/s | 1,862 | 71 ms | 100 ms | 122 ms | 156 ms | 0 | met |
| 100 req/s | 6,201 | 148 ms | 239 ms | 302 ms | 414 ms | 0.017 % | met, p95 near the limit |
| 150 req/s | 7,849 | 2,061 ms | 2,686 ms | 2,817 ms | 3,122 ms | 0.03 % | **not met: saturated** |

On this machine the service sustains about 100 requests per second within the thresholds; beyond that a queue forms and latency climbs. An earlier run at 30 req/s on a less loaded machine gave a p95 of 32 ms, so repeat the measurement before comparing runs.

## Quote latency with the Identity call in the path (local, 2026-10-26)

The table above predates the Identity access call and the single-statement quote write, so the quote was measured again with both in the path. It was not run with k6: the web session cookie is HttpOnly, so a page script in the signed-in browser sent `POST /api/v1/me/quotes` with the same request shape as `quotes.k6.js` (random synthetic customer and credit, a fresh `Idempotency-Key`, one in ten repeated), at an average of 30 requests/s for 60 s after a 10 s warm-up at 6 requests/s. The script sends every request that is due by the clock whenever its timer wakes, so arrivals come in small groups. All 1,800 measured requests returned the quote contract with COP and an `X-Trace-Id` and none failed: 1,620 were `201` and 180 `200`, the replays.

Two clocks give different numbers, and only the second one is the service latency:

| Clock | Average | p50 | p95 | p99 | Max | Against p95 250 ms / p99 500 ms |
|---|---|---|---|---|---|---|
| Browser, from sending to the whole body | 207 ms | 185 ms | 474 ms | 607 ms | 912 ms | Not met, but inflated by queueing |
| Web Worker request time in the local backend log (`wrangler`) | 71 ms | 70 ms | 133 ms | 186 ms | 621 ms | Met |

The browser opens at most six connections to the origin. At 30 requests/s and about 70 ms of service time that cap is close to saturated, so requests wait in the browser before they are sent and the browser figures include that wait. The backend figures are the time the web Worker took, which includes the Identity call and the SQL write. Report the second row as the local result and do not read the first row as service latency. The 100 and 150 requests/s rows above were not repeated: a browser cannot send that rate through six connections, so a k6 run is needed for them. The run is local, with Workers and the database on one machine, and says nothing about dev, staging or prod.

## Finding that changed the code

The first version saturated at about **35 quotes per second**: at 100 req/s the p95 was 5.8 s and 96 % of requests failed. Comparing against a variant without the `COT-YYYY-NNNNN` counter (up to 270/s) implicated that row: the transaction held it locked through multiple sequential client queries before `COMMIT`. Moving the allocation to a short separate statement raised the observed local ceiling to about 190/s. These are historical measurements of earlier implementations.

That intermediate implementation could leave a gap when the later transaction failed. Existing gaps remain valid: codes are unique and readable, not necessarily contiguous.

The current store combines the actor/key lookup, conditional counter allocation and quote/audit/outbox write in one SQL statement. An existing key returns its stored quote or conflict without advancing the counter. A failed statement rolls back the counter along with all business effects. Concurrent first attempts may still allocate an unused number if another attempt wins the actor/key uniqueness constraint; the loser reads that winner in a new snapshot and compares the request fingerprint. The counter is held until this statement commits, but there are no client round trips while it is locked. This is different from the earlier multi-query transaction: capacity and latency must be measured again rather than inferred from historical throughput. The published code, price, fresh authorization and idempotency contract remain unchanged.

`npm run test:quotes:sql` checks both actors, unchanged result/event payloads, identical and conflicting concurrent requests, no counter advancement on replay/conflict, and rollback of the counter/quote/audit/outbox after an injected quote-constraint failure.

## To improve

- Each request opens a new database connection. Hyperdrive pools connections in the remote environments and should help, but it has to be measured there.
- If more than about 100 requests per second per environment are needed, the yearly counter is still one shared row: split it (for example per partner) or change the code format. That is a team decision.
