# Consent

Identity owns the consent record. A customer authorizes, once and explicitly, the query of a fixed list of sources for one purpose; the authorization lasts 90 days and can be revoked at any time. The public contract is [consents.yaml](../../../packages/contracts/openapi/v1/consents.yaml) with [examples](../../../packages/contracts/examples/consents.json). Data shape and permissions are in [Identity and consent data](data.md).

A web session is not consent. Having a consent is not a business permission either: each use of a source checks it again.

## Authorization terms (text version 1)

The terms are defined in Identity and served by `GET /api/v1/consents/terms`; the web channel renders them and never defines them.

| Item | Value |
|---|---|
| Purpose `risk_profiling` | Calculate the risk profile and personalize the premium of the mortgage life insurance tied to the credit. Not used for advertising and not shared with third parties. |
| Validity | 90 days from the grant, revocable at any time from the privacy panel |
| Sources and scopes | `open_finance_bancolombia` / `income_obligations_12m` (Open Finance), `datacredito_experian` / `payment_history_score` (credit bureau), `ruaf` / `affiliation_regime` (open data), `registraduria` / `identity_validation` (open data) |
| Not part of the authorization | Public DANE statistics: aggregate data that identifies no one. They are still listed as a source of the offer and in the audit trail. |

The customer confirms with a mandatory checkbox. The wording of version 1:

| Locale | Wording |
|---|---|
| es-CO | Autorizo a Solventa a consultar las fuentes listadas con el propósito y la vigencia descritos. Quedará registro verificable de esta autorización. |
| en-US | I authorize Solventa to query the listed sources for the purpose and validity described. A verifiable record of this authorization will be kept. |

Changing the purpose, a source, a scope, the validity or the wording requires a new `textVersion`, new fingerprints (below) and keeping the previous wording recoverable in Git. A grant that names an older version is refused with `terms_outdated`, and the customer sees the new text before authorizing again. A consent covers exactly the sources and scopes of the version it was granted under; there is no partial grant.

## Wording fingerprint

The wording the customer reads lives in the web catalogues. To prove later what was authorized, Identity keeps, for the current text version and each language, the SHA-256 fingerprint of the messages listed in `CONSENT_WORDING_KEYS` (`apps/web/src/consent/wording.ts`): purpose, validity, sources with their type and detail, scopes, the DANE note and the checkbox. A grant carries the `locale` the customer read; the record stores it with the fingerprint Identity approved for that version and language, and the seal covers both. A test compares the catalogue with `WORDING_FINGERPRINT` and fails when a listed message changes without the matching update, so a wording change cannot reach a record under the old version.

The web shows only the text version it supports (`SUPPORTED_TEXT_VERSION`). It sends that version, not the one Identity serves: if Identity moved to another version, the grant is refused with `terms_outdated`, and a screen that finds a different version when it loads the terms does not offer the authorization. Titles, buttons and error messages are not part of the wording.

To change the wording: edit the messages, add the new `textVersion` and fingerprints in Identity, update `SUPPORTED_TEXT_VERSION`, and keep the old text in Git history. The fingerprint is a proof of match, not a copy of the text.

## Rules

- **Who:** only the authenticated web user, for their own subject. No identifier is taken from the body. Writes need the configured `Origin`, and an `Authorization` header is rejected, as in [API access](api-access.md).
- **Code:** `CNS-YYYY-NNNNN`, readable and unique per year, next to the internal `(id, version)` key.
- **Status:** `active`, `revoked` or `expired` is computed from `revoked_at` and `expires_at` on every read; it is not stored, so it cannot go stale.
- **Revocation:** sets `revoked_at` on the existing revision. A revoked consent stays in the panel, and decisions already taken with it are kept for audit. Revoking twice returns the same record; an expired consent cannot be revoked.
- **Seal:** a keyed hash of the consent content, including the language and the wording fingerprint, shown in the panel so a later change to the record can be detected.
- **Decline:** "I do not authorize" creates no consent and queries nothing. It leaves only an audit event. The customer keeps the minimum-data estimate; no offer, policy or charge follows.
- **Audit:** grant, decline, revocation and expiry leave an event without personal data and with the correlation ID.
- **Quote reference:** an optional `quoteRef` is stored as a reference. Identity does not read Acquisition data to validate it.

## Fresh access check

Another module that wants to query a source asks Identity, through the Service Binding, whether the consent is valid at that moment: active, not expired, covering the required scope and with an intact seal. Without a valid consent, or if Identity cannot answer, the source and any stored copy are not used and the technical cause is kept. A consent copied into a message or a profile never grants access. A revocation is effective on the next check, well inside the five-minute target of the case study. The check searches only the usable consents of the user, so any number of newer revoked or expired ones never hides an active one.

The private RPC is `verifyConsentV1`, separate from `authorizeApiAccessV1`; it does not authenticate a caller and is not a public route.

```ts
{ subjectToken, purposeCode: 'risk_profiling', scope }
// { allowed: true, consent: { consentId, textVersion, expiresAt } }
// { allowed: false, reason: 'invalid_request' | 'consent_missing' | 'consent_revoked' | 'consent_expired' | 'consent_invalid' | 'unavailable' }
```

`subjectToken` is the internal pseudonymous identifier of the actor already authorized by the caller. `consent_invalid` means the stored record no longer matches its seal. The check is never cached, and the caller treats every `allowed: false` the same way: no source and no copy.

### Guard in Acquisition

Acquisition reaches a source or a stored copy of its data only through `ReadSignal` (`backend/acquisition-risk/src/application/read-signal.ts`). On every call it asks `ConsentGuard`, whose adapter `IdentityConsentGuard` calls `verifyConsentV1` with a 2 s deadline and a fixed purpose, and validates the reply. Any reply it cannot verify, a timeout or an error counts as `unavailable`.

| Consent check | Provider | Stored copy | Result |
|---|---|---|---|
| Denied or unavailable | Not called | Not read | `denied` with the reason |
| Allowed, provider answers | Called | Not read | `available` |
| Allowed, provider fails | Called | Read | `degraded` if the copy was captured under this same valid consent, otherwise `unavailable` |

The check happens before the call and is not repeated afterwards, so a revocation that lands while the provider answers is caught on the next call; there is no distributed atomicity between Identity and Acquisition. `ReadSignal` is not wired to any route yet: the profiling use case will call it, and the real provider adapter replaces the simulated one used in tests.

## Operation

- **Migration:** `0006_consent_records.sql` adds the code counter and the new `consents` columns, among them the language and the wording fingerprint. Apply it before deploying this code, following the [migration guide](../../infrastructure/migrations.md): the read-only plan first, then the apply and `schema-verify --admin`. New columns are nullable so the migration needs no backfill; the service writes all of them and ignores rows without a code. Apply the file as it stands in the merged revision: an applied migration is never edited.
- **Configuration:** `CONSENT_SEAL_KEY` (at least 32 characters, different per environment) keys the seal; without it a grant answers 503 and a check denies. Locally, add it to `backend/identity-consent-ecosystem/.dev.vars`; the local configuration declares it as required, so `wrangler dev` loads it. In dev, staging and prod the operator loads it as a Worker secret of Identity, outside `IDENTITY_AUTH_JSON`, before the consent PR is merged. It is not declared as required for those environments, so a deployment does not fail without it. Later deployments preserve it. Changing the key invalidates the seal of every existing consent, so rotate it only with a migration plan.

The operator keeps an environment-specific, ignored `infra/.local/identity.<environment>.consent.secrets.json` containing only `CONSENT_SEAL_KEY`, with its length and environment verified. It is uploaded to the matching Identity Worker as for the [quote key](../acquisition-risk/README.md), and only the names are listed afterwards:

```sh
node node_modules/wrangler/bin/wrangler.js secret bulk infra/.local/identity.dev.consent.secrets.json --config backend/identity-consent-ecosystem/wrangler.jsonc --env dev --profile solventa-universidad
node node_modules/wrangler/bin/wrangler.js secret list --config backend/identity-consent-ecosystem/wrangler.jsonc --env dev --profile solventa-universidad
```

Replace `dev` consistently for staging or prod. `secret bulk` publishes a new Worker version, so perform it as a coordinated environment operation. The file belongs in authorized custody and never in Git or a request body.

- **Routing:** the web Worker forwards `/api/v1/consents` and its sub-paths to Identity after the version gate.

## Limits

- Expiry has no event of its own. The `consent.expired` audit event is written once, the first time the panel or a check finds the consent expired. If that write fails, the answer does not change: the failure is logged as `consent_expiry_audit_failed` with a short error code and the next read tries again.
- Consent is checked against the actor's subject only; Identity does not read quotes, so `quoteRef` is not validated.
- No source is queried yet. Real providers, their adapters and the use of the answer belong to the profiling work.

## Failures

| Situation | Response |
|---|---|
| No or expired session | 401; renew through `/auth/session` and retry once |
| Origin not configured, or operation outside the web user policy | 403 |
| Missing key, malformed body or unknown field | 400 |
| Outdated text, key reused with another request, revoking an expired consent | 409 |
| Consent of another user | 404, indistinguishable from a missing one |
| Verification or persistence unavailable | 503; nothing is recorded |

## Verification

- `npm run test:contracts` checks the contract and its examples: every operation requires the web session, the status codes of each flow exist, requests accept no extra fields, the status of each example follows its dates, and a consent covers exactly the sources of its terms.
- `npm run test:consents` covers the use cases and the HTTP adapter with in-memory dependencies, validating responses against the contract: grant, retry and conflict, outdated text, decline, ownership, revocation, expiry, tampering, session and origin failures, body limit and unavailable persistence.
- `npm run test:consents:sql` runs the same rules against a disposable local database with the Identity runtime role: one transaction for record, audit and outbox, concurrent retries and revocations, expiry audited once, tampering, and permissions. Run `npm run infra:up` first.
