# Quote load test

Measures the latency of `POST /api/v1/quotes` with [k6](https://k6.io) against the quality scenario: **p95 ≤ 250 ms and p99 ≤ 500 ms**. Synthetic data only.

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

The scenario warms up for 10 s at a low rate, then measures at a constant arrival rate. Each request uses a new `Idempotency-Key`, and one in ten repeats the previous request to exercise idempotency (it must answer 200 with the same quote). Checks cover the status, the `COT-YYYY-NNNNN` code, the COP currency and the `X-Trace-Id` header. k6 thresholds fail when p95 ≥ 250 ms, p99 ≥ 500 ms or more than 1 % of requests fail.

For dev diagnosis, Acquisition emits a structured `quote_sql_slow` log when one SQL store attempt takes at least 250 ms. It includes the trace ID, outcome and elapsed milliseconds for connection, idempotency lookup, counter allocation, the atomic quote/audit/outbox write and close. It does not log credentials or request data. Correlate these stages with Workers wall time and the k6 summary before changing the quote-code allocator; the log is disabled outside dev.

## Baseline before the Identity access call (local, 60 s per load)

Measured when a local stand-in authenticated the request inside Acquisition. The Identity call now adds a hop to every quote, so repeat the test before comparing.

| Load | Requests | Average | p95 | p99 | Max | Failures | Thresholds |
|---|---|---|---|---|---|---|---|
| 30 req/s | 1,862 | 71 ms | 100 ms | 122 ms | 156 ms | 0 | met |
| 100 req/s | 6,201 | 148 ms | 239 ms | 302 ms | 414 ms | 0.017 % | met, p95 near the limit |
| 150 req/s | 7,849 | 2,061 ms | 2,686 ms | 2,817 ms | 3,122 ms | 0.03 % | **not met: saturated** |

On this machine the service sustains about 100 requests per second within the thresholds; beyond that a queue forms and latency climbs. An earlier run at 30 req/s on a less loaded machine gave a p95 of 32 ms, so repeat the measurement before comparing runs.

## Finding that changed the code

The first version saturated at about **35 quotes per second**: at 100 req/s the p95 was 5.8 s and 96 % of requests failed. Comparing against a variant without the `COT-YYYY-NNNNN` counter (up to 270/s) showed that this row was the cause: the quote transaction held it locked until `COMMIT`, so every quote queued behind it. The number is now allocated in a short statement before the transaction (`src/adapters/outbound/sql-quote-store.ts`), which raised the ceiling to about 190/s.

Consequence: if a transaction fails after the number is allocated, the numbering has a gap. Codes stay unique and readable but are not contiguous.

## To improve

- Each request opens a new database connection. Hyperdrive pools connections in the remote environments and should help, but it has to be measured there.
- If more than about 100 requests per second per environment are needed, the yearly counter is still one shared row: split it (for example per partner) or change the code format. That is a team decision.
