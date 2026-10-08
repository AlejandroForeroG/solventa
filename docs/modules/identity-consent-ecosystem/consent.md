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

Changing the purpose, a source, a scope, the validity or the wording requires a new `textVersion`. A grant that names an older version is refused with `terms_outdated`, and the customer sees the new text before authorizing again. A consent covers exactly the sources and scopes of the version it was granted under; there is no partial grant.

## Rules

- **Who:** only the authenticated web user, for their own subject. No identifier is taken from the body. Writes need the configured `Origin`, and an `Authorization` header is rejected, as in [API access](api-access.md).
- **Code:** `CNS-YYYY-NNNNN`, readable and unique per year, next to the internal `(id, version)` key.
- **Status:** `active`, `revoked` or `expired` is computed from `revoked_at` and `expires_at` on every read; it is not stored, so it cannot go stale.
- **Revocation:** sets `revoked_at` on the existing revision. A revoked consent stays in the panel, and decisions already taken with it are kept for audit. Revoking twice returns the same record; an expired consent cannot be revoked.
- **Seal:** a keyed hash of the consent content, shown in the panel so a later change to the record can be detected.
- **Decline:** "I do not authorize" creates no consent and queries nothing. It leaves only an audit event. The customer keeps the minimum-data estimate; no offer, policy or charge follows.
- **Audit:** grant, decline, revocation and expiry leave an event without personal data and with the correlation ID.
- **Quote reference:** an optional `quoteRef` is stored as a reference. Identity does not read Acquisition data to validate it.

## Fresh access check

Another module that wants to query a source asks Identity, through the Service Binding, whether the consent is valid at that moment: active, not expired, and covering the required scope. Without a valid consent, or if Identity cannot answer, the source and any stored copy are not used and the technical cause is kept. A consent copied into a message or a profile never grants access. A revocation is effective on the next check, well inside the five-minute target of the case study.

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

`npm run test:contracts` checks the contract and its examples: every operation requires the web session, the status codes of each flow exist, requests accept no extra fields, the status of each example follows its dates, and a consent covers exactly the sources of its terms.
