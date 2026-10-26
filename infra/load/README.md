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

The 2026-10-26 local run was driven from the browser, not by k6: the web session cookie is HttpOnly, so a page script is the only runner that can use it without handling its value. A page script sent `fetch` requests from the signed-in tab at a constant arrival rate of 10 requests/s for 60 s after a 10 s warm-up at 2 requests/s, with the same request shape as `offers.k6.js` (fresh `Idempotency-Key`, one in ten repeated). The time runs from sending the request to reading the whole body in the browser, which is close to but not the same as `http_req_duration`. It measured 600 requests: zero failures, 80 ms average, 71 ms median, 107 ms p90, 153 ms p95, 245 ms p99 and 319 ms maximum, against the 400 ms p95 and 800 ms p99 objective. All 600 returned the Offer contract and an `X-Trace-Id`; 540 were fresh `201` and 60 were replayed `200`, all `definitive`. It ran with the simulated providers on the local Workers and database, after the 120 ms call budget was added: the backend wrote no `dependency_budget_exceeded` and no `signal_degraded` line, so no call went over budget and no source was replaced. It is not a k6, remote or staging result, and it does not measure each dependency apart.

The scenario warms up for 10 s at a low rate, then measures at a constant arrival rate. Each request uses a new `Idempotency-Key`, and one in ten repeats the previous request to exercise idempotency (it must answer 200 with the same quote). Checks cover the status, the `COT-YYYY-NNNNN` code, the COP currency and the `X-Trace-Id` header. k6 thresholds fail when p95 ≥ 250 ms, p99 ≥ 500 ms or more than 1 % of requests fail.

For dev diagnosis, Acquisition emits a structured `quote_sql_slow` log when one SQL store attempt takes at least 250 ms. It includes the trace ID, outcome and elapsed milliseconds for connection, the combined atomic lookup/counter/quote/audit/outbox statement (`save`), a race lookup when needed, and close. It does not log credentials or request data. Correlate these stages with Workers wall time and the k6 summary before changing the quote-code allocator; the log is disabled outside dev.

## Baseline before the Identity access call (local, 60 s per load)

Measured when a local stand-in authenticated the request inside Acquisition. The Identity call now adds a hop to every quote, so repeat the test before comparing.

| Load | Requests | Average | p95 | p99 | Max | Failures | Thresholds |
|---|---|---|---|---|---|---|---|
| 30 req/s | 1,862 | 71 ms | 100 ms | 122 ms | 156 ms | 0 | met |
| 100 req/s | 6,201 | 148 ms | 239 ms | 302 ms | 414 ms | 0.017 % | met, p95 near the limit |
| 150 req/s | 7,849 | 2,061 ms | 2,686 ms | 2,817 ms | 3,122 ms | 0.03 % | **not met: saturated** |

On this machine the service sustains about 100 requests per second within the thresholds; beyond that a queue forms and latency climbs. An earlier run at 30 req/s on a less loaded machine gave a p95 of 32 ms, so repeat the measurement before comparing runs.

## Finding that changed the code

The first version saturated at about **35 quotes per second**: at 100 req/s the p95 was 5.8 s and 96 % of requests failed. Comparing against a variant without the `COT-YYYY-NNNNN` counter (up to 270/s) implicated that row: the transaction held it locked through multiple sequential client queries before `COMMIT`. Moving the allocation to a short separate statement raised the observed local ceiling to about 190/s. These are historical measurements of earlier implementations.

That intermediate implementation could leave a gap when the later transaction failed. Existing gaps remain valid: codes are unique and readable, not necessarily contiguous.

The current store combines the actor/key lookup, conditional counter allocation and quote/audit/outbox write in one SQL statement. An existing key returns its stored quote or conflict without advancing the counter. A failed statement rolls back the counter along with all business effects. Concurrent first attempts may still allocate an unused number if another attempt wins the actor/key uniqueness constraint; the loser reads that winner in a new snapshot and compares the request fingerprint. The counter is held until this statement commits, but there are no client round trips while it is locked. This is different from the earlier multi-query transaction: capacity and latency must be measured again rather than inferred from historical throughput. The published code, price, fresh authorization and idempotency contract remain unchanged.

`npm run test:quotes:sql` checks both actors, unchanged result/event payloads, identical and conflicting concurrent requests, no counter advancement on replay/conflict, and rollback of the counter/quote/audit/outbox after an injected quote-constraint failure.

## To improve

- Each request opens a new database connection. Hyperdrive pools connections in the remote environments and should help, but it has to be measured there.
- If more than about 100 requests per second per environment are needed, the yearly counter is still one shared row: split it (for example per partner) or change the code format. That is a team decision.
