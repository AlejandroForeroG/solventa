# Claims inbox

Policy, Claims & Payments owns `GET /api/v1/claims`, the operational list of open claims for explicitly granted web analysts. The web workspace is `/siniestros`. [OpenAPI](../../../packages/contracts/openapi/v1/claims.yaml) and [synthetic examples](../../../packages/contracts/examples/claims.json) define the boundary; the web Worker forwards the exact `/api/v1/claims` prefix to this module after the API version gate. The claim file, decisions and notifications are separate work; the claim components in `claims.yaml` are the shared vocabulary for them.

## Authorization and audit

Each request calls Identity's `authorizeApiAccessV1` once, with a two-second deadline, the sealed web cookie and the fixed `claims:read` operation. Identity verifies WorkOS, the active client/session and an [explicit claims grant](../identity-consent-ecosystem/api-access.md#claims-permissions). No actor, role or operation comes from the query. Partners, native users and ordinary web clients are denied even with a valid session, and the audit permission does not confer this one. An Authorization header is rejected.

The list is an operational permission: an authorized analyst reads open claims of every client in the selected environment. Policy checks the lease returned by Identity (at most five seconds) before and after the read, and the read inserts `claims.inbox.read` into `policy.audit_events` in the same transaction that selects the page. If the audit insert fails or the lease expired, the transaction rolls back and no data is released. Search values and amounts are not copied into the audit record. Denials are recorded by Identity's security path. 401 is unauthenticated, 403 missing permission, 400 invalid input, 405 unsupported method and 503 unavailable authorization, SQL or audit; every response carries `traceId`/`X-Trace-Id` and is `no-store`.

## What is listed

Only open claims: `unassigned`, `in_review`, `pending_information` and `escalated`. Claims written by the parametric payment flow (`approved`, then `paid`) are not open and keep their existing values and insert statement. `claims.status` is still unconstrained SQL text, so an unknown state or an open claim missing its number or estimated amount fails the page with 503 rather than being hidden or guessed.

Order: priority (high first), `created_at` ascending, `estimated_amount` descending, then claim id. Pass the last item's id as `before` to continue; filters must be repeated. There is no total, and a cursor that no longer exists returns an empty page. Filters are `state`, `overdue=true` and `query` (exact claim number or policy UUID). Unknown, duplicate or empty parameters return 400 after authorization.

Derived values, never supplied by a caller:

- `ageDays`: calendar days in America/Bogota between `created_at` and now. Colombia has no daylight saving time, so the domain uses a fixed UTC-5 offset and SQL uses the time zone; the SQL smoke checks that both orderings agree.
- `priority`: `high` for 5 or more days or an `escalated` claim, `medium` for 2 to 4 days, `low` otherwise. `overdue` uses the same 5-day threshold. The thresholds are provisional and live once in `src/domain/claims.ts`; the use case passes them to the SQL adapter so ordering and display cannot diverge.
- `evidence`: counts `evidence_metadata` rows in `uploaded` or `verified` state against `claims.evidence_required`. Fewer than required is `incomplete`; enough with any `uploaded` (unverified) item is `in_review`; otherwise `complete`. Nothing is duplicated into the claim row.

## Data

Migration `0009_claims_inbox.sql` adds nullable `claim_number` (unique, `SIN-YYYY-NNNNN`), `estimated_amount DECIMAL(19,4)` and `assignee_id`, plus `currency` (default `COP`), `evidence_required` (default 0) and a partial index of open claims by `created_at`. Existing rows and the parametric insert are unchanged. The runtime grants did not change. Apply it before integrating code that needs it, following the [migration guide](../../infrastructure/migrations.md), and verify with the environment's schema verification.

`assignee_id` holds an Identity client UUID without a foreign key, because owners do not read each other's tables. The claim number has no counter yet: whichever flow creates claims (assisted or mobile reports) must allocate it, as quotes and consents do.

## Limits

- No flow creates open claims yet, so the inbox is empty until one exists or synthetic rows are inserted for verification.
- The list carries no insured name, document or contact data: the policy model stores none. The prototype's insured column is shown as the policy id.
- Opening a claim, approving, rejecting, requesting information and escalating are not implemented.
- Priority and overdue thresholds are provisional, and no p95/p99 latency has been measured; the SQL smoke does not establish the 150 ms criterion.

## Verification

```sh
npm run test:financial        # domain, use case, HTTP, gateway and OpenAPI agreement (tests/claims-inbox.test.ts)
npm run test:claims:sql       # disposable local SQL: real 0009 migration, grants, ordering, filters, pagination, evidence, audit and fail-closed cases
npm run test:pact             # SPA consumer contract and gateway/provider states
npm run test:web              # workspace behavior, English copy, states and accessibility
```

`test:claims:sql` creates and drops a generated local database and touches no remote environment. Browser checks, real analyst access and measured latency in dev or staging require separate evidence.
