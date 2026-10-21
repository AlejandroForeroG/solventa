# Identity verification

Identity owns identity-verification state independently of authentication sessions and business permissions. The provider boundary currently has a port, a strict synthetic result translator, deterministic rule tests and a versioned valid/negative corpus. It is not mounted on an HTTP route or called by the mobile application yet. There is no durable verification or assisted-request store in this increment so far.

The intended channel uses synthetic document, selfie and liveness material without camera capture. Provider evaluation is simulated; authentication, authorization, consent, persistence and auditing must remain real when connecting the use case. A simulated approval does not attest legal identity, live capture or fraud-detection efficacy, and does not grant permission to contract.

## Provider boundary

`IdentityVerificationProvider` accepts an evaluation UUID and three evidence references with SHA-256 and corpus version. It has no WorkOS token, personal identifier or image field. `KycProvider` injects a source and a positive, finite deadline. It bounds even a source that ignores cancellation, cancels outstanding work and normalizes failure to `timeout`, `unavailable` or `invalid_response`, without returning an upstream exception message.

The source result format is `synthetic-kyc.v1`, described by [the schema](../../../packages/contracts/schemas/identity-verification-provider.v1.json). It echoes the evaluation UUID, identifies itself as simulated and contains only an opaque provider reference, completion time, the three checks and screening status. Unexpected fields, unsupported versions, impossible dates, missing checks and responses for another evaluation are rejected. A failed or unavailable provider cannot produce an approval.

The synthetic result vocabulary distinguishes `approved`, `not_verified` and `review`. All three checks must pass and screening must be clear for a simulated approval. A screening match or review result remains a verification review; it is not a definitive underwriting rejection. Only individually passed evidence is eligible to be carried forward, and a future use case must also check its current owner, consent and expiry. No current helper establishes that authorization or persistence.

The [corpus](../../../packages/contracts/examples/identity-verification-provider.json) covers passed and failed steps, review, malformed data and mismatched evaluations. It runs through the actual adapter in `tests/identity-verification-provider.test.ts`, together with controlled-time cancellation and safe-error tests. These checks do not establish an end-to-end mobile journey or a SQL transaction.

## Integration limits

Consent wording/validity, progress expiry, input custody and retry policy must be confirmed before their dependent behavior is connected. Keep the KYC consent distinct from financial risk profiling. The existing 90-day financial grant is not authorization for KYC.

The completed flow must enforce server ownership and fresh authorization, bind each provider evaluation to its immutable attempt inputs, apply only a still-current result, and commit state, capture, audit and outbox in Identity's transaction. Provider calls must occur outside SQL transactions. Repeated requests need stable idempotency and payload-conflict detection, including recovery after an uncertain response. An assisted request must have a persisted reference and pending state; operator resolution is outside the channel increment.

No KYC migration, public endpoint, consumer Pact, native verification or deployment is claimed by the provider component alone. Update this guide, the owner data guide, the mobile guide, OpenAPI and the actual consumer contract together when connecting them.
