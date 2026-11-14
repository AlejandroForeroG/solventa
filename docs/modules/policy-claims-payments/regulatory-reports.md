# Regulator and reinsurer reports

Policy, Claims & Payments owns the monthly reports for a simulated regulator and a simulated reinsurer: generation, custody, download and delivery. The web workspace is `/reportes`. [OpenAPI](../../../packages/contracts/openapi/v1/reports.yaml), [synthetic examples](../../../packages/contracts/examples/reports.json) and the delivery schemas ([regulator](../../../packages/contracts/schemas/report-delivery-regulator.v1.json) and [reinsurer](../../../packages/contracts/schemas/report-delivery-reinsurer.v1.json)) define the boundary; the web Worker forwards the exact `/api/v1/reports` prefix to this module after the API version gate. Both destinations are simulations: nothing here claims regulatory compliance, a real recipient's acceptance, cession of risk or a contract with a reinsurer.

## Authorization and audit

Each route calls Identity's `authorizeApiAccessV1` once, with a two-second deadline and the sealed web cookie, for exactly one operation: `reports:generate` (`POST /api/v1/reports`), `reports:read` (`GET /api/v1/reports`), `reports:download` (`GET /api/v1/reports/{reportId}/download`) and `reports:send` (`POST /api/v1/reports/{reportId}/delivery`). A valid session is never enough and one grant opens one operation; see [report permissions](../identity-consent-ecosystem/api-access.md#report-permissions). Partners, native users and ordinary web customers are denied, and an Authorization header is rejected. Policy checks the returned lease (at most five seconds) before and after each operation, and the audit insert that accompanies each read, generation, download and delivery step fails, and rolls the transaction back, once the lease has expired.

The reports are an operational view of every client in the environment, like the [claims inbox](claims-inbox.md): an authorized operator is not limited to customer-owned data. Another customer, a partner or an operator holding a different report operation reaches nothing, and an unknown report id is a 404 after authorization. Denials are recorded by Identity's security path. Writes require the same-origin check Identity performs for a sealed web session.

Every successful operation inserts into `policy.audit_events` in the same transaction: `reports.generate` (outcome `created` or `unchanged`), `reports.list`, `reports.download` (outcome `success`, `not_found` or `integrity_failure`, recorded after the artifact is verified and before it is released, so a refused file is never audited as a download), `reports.send` and, for the delivery, `reports.delivery.dispatched`, `reports.delivery.acknowledged`, `reports.delivery.rejected` or `reports.delivery.uncertain`. The actor is the operator's internal client UUID. Search values, amounts and file contents are never copied into the audit record, and the existing provisional 90-day audit retention applies. Delivery outcomes are recorded even when the authorization lease has meanwhile expired, so a provider outcome is never lost, but the dispatch transition that precedes sending is guarded by the lease.

## What a report contains

The caller sends only `{ "period": "2026-11", "destination": "regulator", "format": "csv" }`; the body is rejected if it carries anything else, so totals or rows can never be supplied as facts. The period is a calendar month in America/Bogota (fixed UTC-5, as in the claims inbox) and a month that has not started is rejected. The current month is allowed: a later change simply produces a new revision.

Facts are read from Policy's own tables in one `READ ONLY` transaction, so the whole report comes from a single consistent snapshot:

| Fact | Source and placement in the month |
|---|---|
| Issued policies (`policy_issued`) | `policy_signatures.signed_at` of policies with status `issued` |
| Modified, renewed and cancelled policies (`policy_modified`, `policy_renewed`, `policy_cancelled`) | `policy_lifecycle_changes.occurred_at`, action from the sealed payload |
| Claims | `COALESCE(submitted_at, created_at)` of every claim that is not a `draft`; an unknown state fails the report instead of being hidden |
| Payments | `updated_at` of premium and indemnity payments in state `confirmed` or `refunded`; pending and declined payments are not confirmed facts |

The same snapshot also sums each group again in SQL. The use case compares those independent aggregates with the totals it derives from the rows, and again with the totals it reads back from the finished CSV; a mismatch stores nothing and returns 503 `reconciliation_failed`. Money keeps `DECIMAL(19,4)` strings and exact integer arithmetic, never floating point. An estimated claim amount is the analyst's estimate, not a confirmed payment, and a claim without an estimate adds nothing to the total (the CSV leaves its amount empty, never zero).

Data minimization: a report holds policy, claim and payment identifiers, the claim number, coverage kind, states, instants, decimal amounts and the synthetic payment reference. It never holds a client or subject identifier, a name, a document, contact data, a claim description or place, a location or any identity verification data.

### Formats

Each destination has its own versioned format, one CSV with a `record_type` column and a fixed header per version. Rows are sorted by instant and identifier, so the same facts always give the same bytes and the same hash.

- `regulator-portfolio.v1`: one row per issued, modified, renewed or cancelled policy, plus totals only for claims (`claim_total`, per state) and payments (`payment_total`, per operation and state). Individual claims and payments are not sent.
- `reinsurer-bordereau.v1`: the same policy rows, plus one `claim` row per claim and one `payment` row per confirmed or refunded payment with its reference, so they can be reconciled one by one.

The manifest (`ReportManifest`, `academic-report-1`) carries the format version, period, destination, revision, generation instant, the SHA-256 of the CSV bytes, the row count, the count per record type and the totals as groups (`policy_issued`, `claim:<state>`, `payment:<operation>:<state>`, each with currency, count and amount). A period without data is a valid report: the CSV is only its header and the manifest has no totals.

## Revisions and custody

Revisions live in `policy.report_revisions`: the CSV, its manifest and hash, the format version, the generation instant and the operator. The runtime role can only insert and select, so a stored revision cannot be updated or deleted through the application; only a database administrator could, and that is not detected apart from the checks below. SQL, not an object store, holds the artifact: the revision, its hash and its audit record commit in one transaction, which an object store would not allow, and the volume is small and synthetic.

- The same content for the same month and destination is the same revision: generating twice returns it with `created: false` (HTTP 200).
- A changed fact set gives another content hash and the next revision number (HTTP 201). The earlier revision, and any delivery attached to it, is never overwritten. Two concurrent generations of the same content produce one revision: the unique `(period, destination, content_hash)` and `(period, destination, revision)` indexes decide, and the loser retries and reads the winner.
- Download returns the CSV (`?file=csv`, default) or the manifest (`?file=manifest`) as an attachment with `X-Report-Hash`. Before releasing, it recomputes the SHA-256 of the stored CSV and compares it with the stored hash and the manifest's hash; a mismatch is 409 `integrity_violation` and nothing is returned.

## Delivery

A revision has at most one delivery (`policy.report_deliveries`, unique by report), so its identity survives retries. States are separate: `pending` (requested), `dispatched` (sent, no answer yet), `acknowledged` (the destination confirmed, with its `MOCK-RPT-<id>` reference), `rejected` (with a code) and `uncertain` (no answer within the 700 ms hard limit). `uncertain` is never shown as success.

`POST /api/v1/reports/{reportId}/delivery` works like the premium charge: it commits the delivery record and its audit first, never keeps a SQL transaction open during the destination call, then records the outcome.

1. A final state (`acknowledged` or `rejected`) is returned as it is, without calling the destination.
2. Otherwise the destination is asked what it already recorded for that delivery identity. If it answers, that outcome is stored and nothing is sent again. The authorization lease is checked again after that question: once it has expired nothing is dispatched and the delivery stays `pending`. The `dispatched` transition itself is guarded by the lease in its own transaction. An answer already received is still recorded, but its status and reference are returned only while the authorization holds; otherwise the request fails and the stored outcome is read on the next authorized call.
3. If it has nothing, the delivery is marked `dispatched` (attempts + 1) and sent. An answer inside the deadline is stored; a timeout or a transport failure stores `uncertain`.
4. The response is 200 with the delivery; the web workspace shows `uncertain` as such and offers "Retry delivery", which repeats the steps above with the same identity.

Retries never repeat a confirmed outcome: the destination keeps its own ledger keyed by the delivery identity, and a repeated delivery returns the original answer. Two concurrent sends are serialized by that key and end in the same stored outcome. A rejection is final for that revision: the destination judged the content, so a corrected report is another revision.

### Simulated destinations

`SqlMockReportDestination` implements the `ReportDestination` port once per destination and is built only in `src/index.ts`. It validates what it receives and records its answer in `policy.report_destination_receipts`. A rejection is a consequence of the content, not of the sender:

| Code | Cause |
|---|---|
| `invalid_message` | the envelope or its manifest is not the exact versioned shape of that destination: every manifest field (rule version, period, revision, instant, counts, record types) is checked, not only the hash and the totals |
| `destination_mismatch` | the message is addressed to the other destination |
| `unsupported_format_version` | a format version other than its own |
| `hash_mismatch` | the SHA-256 of the CSV differs from the manifest |
| `malformed_csv` | wrong header, wrong column count or an unreadable row |
| `totals_mismatch` | totals, counts or rows recomputed from the CSV differ from the manifest |

Each destination has its own corpus, [regulator](../../../packages/contracts/examples/report-deliveries-regulator.json) and [reinsurer](../../../packages/contracts/examples/report-deliveries-reinsurer.json), with two valid cases, one delivery whose answer never arrives (the destination records it and answers once asked again) and eleven negative ones that cover every code above; `tests/regulatory-reports.test.ts` runs every case on each `npm run check` (the unanswered one against an in-memory destination, and `test:reports:sql` against the real simulated destination and its ledger), requires the valid ones to satisfy that destination's schema and the foreign-destination and wrong-version ones to fail it, and checks that the valid ones are exactly what the builders produce. The configuration switch `REPORT_DESTINATION_FAULT` is read only in the composition root. It is `none` in every environment; with `timeout` the destination records its receipt and withholds the answer, which shows an `uncertain` delivery locally and in tests without a second implementation. Set it only in a local `.dev.vars`.

Each delivery is logged as `report_delivery` with environment, trace, destination, status and duration (`overBudget` above the 120 ms budget). No report, policy or person identifier is logged.

## Decision capture and events

Generating a report derives a document from persisted facts and sending it records an external answer; neither applies a business rule to a customer, policy or claim, so they carry no `decision-capture.v1` instance, like a query that makes no decision. What explains them later is stored with them: the revision keeps its manifest (rule version `academic-report-1`, period, destination, format, hash and totals), the delivery keeps its state, attempts, destination reference or rejection code, and the audit records the operator and trace of every step. The delivery is synchronous with SQL state rather than an outbox event, because the operator needs the answer in the request and the destination's own ledger gives the idempotency an event consumer would otherwise provide. No outbox event is written and nothing consumes one for reports.

## Data and migration

Policy `0018_regulatory_reports.sql` adds `report_revisions`, `report_deliveries` and `report_destination_receipts`; their runtime grants are `SELECT, INSERT`, `SELECT, INSERT, UPDATE` (state only) and `SELECT, INSERT`. Identity `0017_report_access_grants.sql` adds the permission ledger. Normal Deploy applies both before publishing the dependent code ([migration guide](../../infrastructure/migrations.md)). Number `0018` leaves `0016` and `0017` free for the claim decision migrations already in `dev`; the runner rejects out-of-order history, so those must reach an environment before this one does.

## Limits

- Both destinations are simulations and the format is academic. No claim of regulatory compliance, acceptance by a real recipient or cession of risk.
- Claim approval and rejection come from the claim decisions, which are not in every environment yet; until then claim totals reflect only the states that exist there, such as `paid` claims of the parametric flow.
- The stored artifact is protected from the application, not from a database administrator.
- An `uncertain` delivery resolves only when an operator retries; there is no background reconciliation.
- The report is read in one request. Volumes are synthetic and small; a very large period would need paging or an object store.
- Latency was not measured, and the browser flow was checked only with the component tests (no real operator session).

## Verification

```sh
npm run test:integrations     # corpus, formats, use cases (tests/regulatory-reports.test.ts)
npm run test:financial        # HTTP, authorization and OpenAPI agreement (tests/regulatory-reports-http.test.ts, tests/report-access.test.ts)
npm run test:web              # workspace behavior, copy, states and accessibility
npm run test:reports:sql      # disposable local SQL: real 0018 migration and grants, Bogotá boundaries, revisions, delivery and audit
```

`test:reports:sql` creates and drops a generated local database and touches no remote environment.
