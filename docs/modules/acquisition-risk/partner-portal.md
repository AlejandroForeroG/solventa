# Partner portal

The authenticated web route `/socios` reads `GET /api/v2/partner-portal?from=YYYY-MM-DD&to=YYYY-MM-DD`. Dates are inclusive UTC calendar dates, at most 31 days. See the [OpenAPI contract](../../../packages/contracts/openapi/v2/partner-portal.yaml) and [synthetic example](../../../packages/contracts/examples/partner-portal-v2.json).

## Authorization

Identity verifies the existing WorkOS web session and an explicit user-to-partner grant. The active client, exact subject/session, nonrevoked session, active partner and current grant must match. Mobile and M2M credentials cannot read the portal. Ordinary customers have no portal permission. The single Identity RPC returns safe metadata and a lease bounded by session expiry, grant expiry and five seconds. Acquisition checks the lease before and after reading. Revocation affects the next authorization; an issued lease can remain valid for at most five seconds.

Each backend queries only its own schema. The caller cannot choose a partner. No provider credential reference, token, customer identity, signal or decision capture is returned. Credential ids are registration references, not credentials. The 20 newest registrations include scopes, expiry and active/expired/revoked state; `hasMoreCredentials` reports truncation.

## Channel facts

One SQL statement gives complete-period aggregates and the 20 most recent facts one consistent snapshot. Ordering is timestamp, id and kind descending. `hasMore` reports additional facts; narrow the period to inspect a smaller range. This increment has no cursor or export.

| Fact | Attribution | Meaning |
|---|---|---|
| Minimum quote | `quotes.partner_id` | `completed`: one stored quote |
| Profiled offer decision | `underwriting_decisions.input_snapshot.channel`, kind `partner` and authorized partner id | `accepted`, `preliminary`, `declined`: underwriting outcome |

The customer-owned quote created inside a partner offer is not counted again. Idempotent retries reuse the original record. Favorable underwriting does not establish customer acceptance, payment or issuance. This ledger excludes HTTP failures, validation denials and outages: it cannot provide an error count of zero, success rate or quota consumption. Zero counts mean a successful query found no facts; failures return unavailable without substituted counts.

The partner catalog exposes mortgage life quotes and profiled offers through actual v1 paths. Flight/weather remain outside that catalog. Versions come from the public registry at composition time; not every operation supports every registered version. Quota is the current enforced UTC-day admission window returned by Identity. It is separate from historical commercial facts and the selected date range. External business providers retain explicit mock mode.

## Grant administration

Identity migration `0014_partner_portal_grants.sql` and SELECT-only runtime grants must precede Worker publication through the normal environment-bound job. No automatic enrollment, email inference or organization claim creates access. A user has at most one unrevoked binding; revoke an expired binding before replacing it.

An authorized administrator uses the selected environment's existing SQL custody, following [migration/recovery procedures](../../infrastructure/migrations.md). Operator references provide traceability; SQL privileges authenticate administration. Keep command files private and outside Git.

```sh
node infra/partner-portal-access.mjs local grant /private/grant.json
node infra/partner-portal-access.mjs local revoke /private/revoke.json
```

Grant files contain exactly `grantId`, `clientId`, `partnerId`, `expiresAt`, `operatorReference`: identifiers are UUIDs; expiry is canonical UTC, future and at most 90 days. Revocations contain exactly `grantId`, `operatorReference`. The operator validates active client/partner and commits the change and audit together. Exact grant replay has no duplicate effect; conflicting input or a revoked id fails. Revocation replay is harmless. Runtime cannot administer grants.

## Channel and verification

The web client validates responses and displays applied period separately from editable dates, snapshot time and explicit loading/empty/denied/unavailable states. Changed filters cancel prior requests and discard late answers. Focus/visibility refresh access; backgrounding removes protected content. Session loss/logout unmounts the portal. Business data never enters localStorage.

Run `npm run test:partner-portal`, `npm run test:partner-portal:sql`, `npm run test:web`, `npm run test:pact`, `npm run test:schema` and `npm run check`. SQL checks require local infrastructure and use a disposable synthetic database. These test boundaries do not establish an authenticated remote browser journey or real provider transactions.

## Shared daily admission quota

Identity migration `0016_partner_quotas.sql` persists a default of **1,000 admitted requests per active partner per UTC day**, shared by `POST /api/v1/quotes` and `POST /api/v1/partner/offers`. A per-partner override replaces that limit. Counter admission is atomic under concurrency; requests beyond the cap receive `429 quota_exceeded`, a canonical trace and `Retry-After` whole seconds until the next UTC day. Counter/configuration failures return 503 and start no downstream business effect. Reducing a limit never resets usage; remaining is `max(0, limit-used)`.

An external quote consumes after verified M2M authorization. An external offer consumes once after Identity verifies the customer's exact partner authorization and fresh risk consent; its internal customer quote consumes no second unit. Every admitted HTTP attempt counts, including a business-idempotent retry and a downstream validation/business/technical failure. Rejected authentication/authorization/consent, quota refusals, probes, web/native requests and portal reads do not count. Client-supplied trace/idempotency values cannot deduplicate admission. Business replay remains separately idempotent. An uncertain commit returns 503 without automatically incrementing again. A known serialization conflict can retry once; crossing UTC midnight while waiting rolls back the old-day increment before retry.

The v2 portal returns `configured:true`, effective `limit`, `used`, `remaining`, `windowStart`, `resetsAt`, `trackingSince`, `updatedAt` and `timeZone:UTC`. `trackingSince` is the persisted policy configuration instant. It does not establish instrumentation coverage before quota-enabled Identity was published: the first day can be partial, and historical attempts are never reconstructed from quotes or underwriting facts. A successful query with valid configuration and no current window means zero admissions under this control. No failed query substitutes zero.

The original v1 projection cannot represent configured quotas. It preserves its old shape for an unconfigured dependency during rollout, but returns its documented 503 when Identity supplies a configured quota. Consumers must use v2; the legacy contract is not silently widened to a shape older clients reject. Quote/offer APIs remain v1 and document their new 429 response. The catalog lists each operation's actual version.

Runtime can SELECT policy/overrides and SELECT/INSERT/UPDATE windows; only an authorized SQL operator changes limits. Use `node infra/partner-quota.mjs <environment> <private-file>` with exactly `partnerId`, integer `dailyLimit` (1 through 1,000,000,000) and `operatorReference` UUID. The existing environment-specific administrative connection authenticates the operation; the UUID supplies audit attribution. The change and before/after audit commit together. There is no public quota administration route or automatic enrollment.

Run `npm run test:partner-quota:sql` for the real default, concurrent cap, partner isolation, limit reduction, administrative-audit rollback and fail-closed counter/configuration cases. The CI workflow runs this disposable-database check. Adapter/HTTP/contract tests preserve bounded Retry-After and distinguish quota usage from business facts.
