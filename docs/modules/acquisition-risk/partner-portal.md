# Partner portal

The authenticated web route `/socios` reads `GET /api/v1/partner-portal?from=YYYY-MM-DD&to=YYYY-MM-DD`. Dates are inclusive UTC calendar dates, at most 31 days. See the [OpenAPI contract](../../../packages/contracts/openapi/v1/partner-portal.yaml) and [synthetic example](../../../packages/contracts/examples/partner-portal.json).

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

The partner catalog exposes mortgage life quotes and profiled offers through actual v1 paths. Flight/weather remain outside that catalog. Versions come from the public registry at composition time; not every operation supports every registered version. Quota is `configured:false`: no configured limit or consumption ledger exists. This read neither invents nor enforces a quota. External business providers retain explicit mock mode.

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
