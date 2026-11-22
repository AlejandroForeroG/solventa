# Assisted sale by an advisor

An advisor with a current professional permission can prepare a quote and an offer for a customer who authorized them, using the same quote, consent-bound profiling and offer rules as the customer's own web journey. The advisor only prepares. Reviewing, accepting, paying and signing stay with the customer, in the customer's own authenticated session, through the existing offer and policy routes. No advisor session can perform those steps for the customer.

The model mirrors [partner authorizations](partner-authorizations.md) with an advisor in place of a partner, and reuses the advisor's professional permission that [policy lifecycle](../policy-claims-payments/policy-lifecycle.md) already describes (`policies:manage-delegated`) instead of creating another one.

## Who decides what

| Decision | Owner | Evidence |
|---|---|---|
| The person may act as an advisor | An administrator, through a professional grant that is current, bounded to 90 days and revocable | `identity.policy_advisor_grants`; the web session still has to be valid |
| This advisor may prepare a sale for this customer | The customer, per advisor, for one operation, at most seven days, revocable | `identity.advisor_sale_authorizations`, with an audit event and an outbox event committed with each change |
| The customer's data may be used to profile them | The customer, through the `risk_profiling` consent | Verified fresh on every advisor request: the four risk scopes under one current consent |
| The offer is accepted, paid and signed | The customer alone | The existing customer flow; the offer belongs to the customer, so an advisor session cannot even read it |

An authorization is not consent, and consent is not an authorization: either one missing blocks the offer.

## Customer authorization

The routes belong to the authenticated web customer and take no customer identifier from the body or the path ([contract](../../../packages/contracts/openapi/v1/advisor-sale-authorizations.yaml)).

- `POST /api/v1/me/advisor-sale-authorizations` names the advisor by the reference that Solventa shows in the advisor workspace and the validity in days (one by default, at most seven). Each call creates a distinct authorization, and a customer can hold at most 20 active ones at once (`409 authorization_limit`), so the list, which shows the active ones first, always includes every authorization that still works. An unknown reference, an advisor whose permission is revoked or expired, and the customer's own reference are one opaque `404 advisor_not_found`, so a reference cannot be probed.
- `GET /api/v1/me/advisor-sale-authorizations` lists the customer's own authorizations, at most 50, with a status computed on every read (`active`, `revoked`, `expired`).
- `POST /api/v1/me/advisor-sale-authorizations/{id}/revoke` is effective on the advisor's next request, is idempotent and answers an opaque `404` for a foreign or unknown id. An expired authorization cannot be revoked (`409`).

The operations `advisor-sale-authorizations:read` and `advisor-sale-authorizations:write` exist only for the web channel. A partner credential, a native session and an `Authorization` header never reach them.

## Advisor access decision

`authorizeAdvisorSaleV1` is a private Service Binding call from Acquisition to Identity. In one call it:

1. verifies the advisor's sealed web session and Origin and the professional permission (`policies:manage-delegated`, with the short lease described in [policy lifecycle](../policy-claims-payments/policy-lifecycle.md));
2. finds the authorization by its id **and** the advisor's own reference, only while it is not revoked, not expired and its customer is active;
3. verifies the customer's four `risk_profiling` scopes under one current consent;
4. returns the advisor reference, the customer identifiers, the authorization expiry, the consent that applies and `leaseExpiresAt`, the end of the advisor's own short professional permission (a lease of at most about five seconds, checked here to be current and not longer than Identity ever grants).

An unknown, foreign, revoked and expired authorization, a session without advisor permission and an advisor acting on their own account are indistinguishable (`403 forbidden`), and each is recorded as a security decision for `advisor-sale:prepare`. A customer without a current consent is `403 consent_required`. Any technical failure verifying or recording is `503` and blocks the offer. The advisor never names the customer: only the authorization they hold leads to one.

## Advisor offer

`POST /api/v1/advisor/offers` ([contract](../../../packages/contracts/openapi/v1/advisor-offers.yaml)) takes the authorization id and the same quote fields as the partner route, with an `Idempotency-Key`. The gateway forwards it to Acquisition with the advisor's cookie untouched and a 4 KiB body limit.

- The quote and the offer are saved for the customer. The customer's own acceptance later runs the existing `offers:accept` path.
- The offer window ends with the earlier of the customer's consent and the authorization.
- The idempotency key is scoped to the advisor reference and the authorization, so another advisor, another authorization or a partner never replays it. The same key and request return the original offer (`200`); another request under the key is `409 idempotency_key_reused`; a retry after a lost answer creates no second quote or offer.
- A degraded signal keeps the offer preliminary and not contractable, exactly as in the customer's journey.
- **The advisor's lease is a deadline of its own.** The permission that opened the request lasts seconds, while the offer stays valid for its own window (the earlier of the customer's consent and the authorization, at most fifteen minutes); the two are never mixed. `leaseExpiresAt` is re-checked before the quote is saved, before the signals are read, before the offer is written and before anything is handed back, and it is enforced where the data commits: the statements that save the quote and create the offer, or decline it, write nothing at or after the lease and the store raises `LeaseExpired`. A sale that outlives the permission is a `503 access_unavailable` (never a success and never read as a consent refusal), writes no quote, offer, decision, audit or event, and the same request with the same key succeeds under a fresh permission and creates one offer. If the lease ends after a write is already durable, that offer is not handed to the advisor; a retry with the same key replays it.
- A bearer token is rejected with `400`.

## Traceability

The retained underwriting decision records `channel: { kind: 'advisor', advisorReference, authorizationId }` in its capture, validated by `decision-capture.v1.json`. Acquisition's audit reads it back: the detail of an underwriting decision shows the channel ([contract](../../../packages/contracts/openapi/v1/underwriting-decisions.yaml)). The policy that results from the customer's acceptance carries the `offerId` that Policy already stores, so an auditor goes from the policy to its offer and from the offer to the decision that names the advisor and the customer's authorization. The advisor identity is a pseudonymous reference, never a name or a customer identifier.

## Handoff to the customer

The advisor sees the offer code (`offerId`) with a copy button and gives it to the customer outside Solventa. The customer's authorization code and the advisor reference are also shown with copy buttons. In the web application the customer opens **Venta asistida** and enters the code; the offer then replaces the authorization form on the page. The page reads the offer by its code (`GET /api/v1/offers/{offerId}`, owner only) and continues in the existing review, acceptance, payment, signature and issuance steps. The customer needs their own current consent; without it the offer is not prepared in the first place.

## Data

`identity.advisor_sale_authorizations` is Identity-owned: a foreign key to the advisor's professional grant and to the client, one `operation` limited to `advisor-sale:prepare`, grant and expiry timestamps (at most seven days) and an optional revocation timestamp. The runtime role can SELECT, INSERT and UPDATE but not DELETE. The migration is `0018_advisor_sale_authorizations.sql`; Acquisition and Policy need none, because the channel travels inside the decision capture.

## Verification

- `tests/advisor-sale-authorizations.test.ts`: the customer's grant, list and revoke, the access decision and every denial.
- `tests/advisor-offers.test.ts`: the use case, the route, the Identity adapter and the scoped key.
- `tests/advisor-sale-journey.test.ts`: the real gateway, Identity and Acquisition routes with in-memory stores and mock signals, including a slow step that outlives the permission: a complete preparation, a foreign advisor, an invented authorization, a customer session, revocation of the authorization and of the consent, expiry, an Identity outage and retries without duplicates; every response is validated against the committed contract.
- `npm run test:advisor-sale-authorizations:sql` runs the real SQL suite with the runtime role: atomic audit and outbox, exact advisor lookup, ownership, idempotent revocation, expiry and the schema bounds.
- `npm run test:advisor-sale:sql` runs the complete sale on one disposable database with the three owners' schemas and runtime roles: the customer's authorization, the advisor's offer, the signed acceptance by the customer, its import into Policy, the mock charge and signature, issuance, the replays without duplicates, the policy's path back to the advisor through its offer, the denial after revocation or withdrawn consent, a slow sale that outlives the advisor's permission (nothing written, then one offer under a fresh permission) and the refusal by the database itself of a quote or an offer that would commit after the lease. The web sessions, the customer's consent check and the external providers are stand-ins.
- `tests/pact/sale.consumer.test.ts`: the web client's contract with the gateway, verified against the real handlers.
- `apps/web/src/sale/sale.test.tsx`: the screens.

## Limits

- The reference of the advisor and the offer code travel outside Solventa, by the people involved. Neither identifies a customer by itself.
- A preliminary offer cannot be accepted. Re-evaluating it from the customer's screen creates a new offer through the customer's own journey, which names no advisor.
- Policy stores no advisor field: the link is the offer's decision capture, reachable from the policy's `offerId`.
- Professional permissions are granted administratively; there is no self-service registration of advisors.
- The providers are mocks: no real signal source, payment or signature is involved.
- The complete-sale suite proves the owners' real SQL and use cases together, not a real browser session of two accounts; the deployed environment still needs an advisor permission granted by a SQL administrator for that.
