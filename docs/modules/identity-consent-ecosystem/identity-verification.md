# Identity verification

Identity owns native onboarding independently of authentication sessions, device biometrics and business permissions. The mobile channel accepts explicit KYC consent, selects three versioned synthetic files, submits them for simulated KYC/AML evaluation, resumes persisted progress and offers manual retries or a persisted assisted request. Approval never grants contracting permission, changes account/session status or constitutes a legal certificate.

Business-provider responses are simulated. WorkOS authentication, server authorization, SQL transactions, seals, idempotency, audit and decision capture remain real. No camera, gallery upload, personal identifier, personal image, biometric template or external provider credential is accepted. The Acquisition `identity_validation` signal and financial risk consent remain separate.

## Consent, evidence and outcomes

Consent purpose is `identity_verification`, text version 1, in `es-CO` or `en-US`. The server supplies exact wording and records its SHA-256, locale, grant time and consent UUID. Consent and reusable progress last exactly 24 hours from database-observed grant time; edits/retries do not extend validity. Revocation or expiry blocks evaluation and reuse. A new attempt requires explicit new consent and starts with empty evidence, without inheriting an assisted request. Revocation remains available during processing and after an uncertain evaluation response.

The [corpus](../../../packages/contracts/src/identity-fixtures.ts) contains nine actual PNGs under `packages/contracts/fixtures/identity/`, labeled synthetic without personal data. The mobile picker previews only these bundled files. The server accepts a step-bound reference, exact SHA-256 and `synthetic-identity.v1` version from its allowlist; submitted verdicts and arbitrary images are rejected. SQL stores references/hashes, not bytes. File/hash tests validate committed assets. A corpus change needs coordinated server/client contracts; this is not a general JPG/PNG upload endpoint.

The steps are `document`, `selfie` and `liveness`. Approval requires all checks to pass and screening to be clear. A screening match or review check produces `review`, never an underwriting decision. A failed check produces `not_verified` and removes only failed/review evidence from reusable progress; passed steps remain during consent validity. Technical failure produces `unavailable`, preserves all selected steps and asserts no identity rejection.

Retries are explicit, with no business attempt limit within the 24-hour period. After the first failed evaluation, `assistanceAllowed` remains available even when a failed step is edited. Assistance persists one opaque reference and `pending` state; repeats do not open another request. Operator assignment, resolution and notifications are outside this increment. Existing assistance stays pending after later automatic approval; no operator resolution is inferred.

## Public API

The [OpenAPI specification](../../../packages/contracts/openapi/v1/identity-verifications.yaml), [examples](../../../packages/contracts/examples/identity-verifications.json) and [mobile consumer Pact](../../../packages/contracts/pacts/solventa-mobile-solventa-web.json) describe the same public gateway boundary.

| Method/path, relative to `/api/v1/mobile/identity-verifications` | Input | Result |
|---|---|---|
| GET `/terms?locale=es-CO` | Supported locale, defaults to Spanish | Wording, hash, version and 24-hour validity |
| GET `/fixtures` | None | Versioned synthetic metadata |
| GET root | None | Current owned verification, or null |
| POST root | `textVersion`, `locale` | 201: explicit consent and attempt |
| PUT `/{id}/steps/{step}` | Reference, hash, corpus version, `expectedVersion` | 200: updated progress |
| POST `/{id}/evaluate` | `expectedVersion` | 200: saved result; 503 with saved verification on technical provider failure |
| POST `/{id}/assistance` | `expectedVersion` | 200: one persisted pending assisted request |
| POST `/{id}/revoke` | Empty JSON object | 200: revoked consent and cleared progress |

All routes verify native WorkOS bearer credentials and the current local session. Only explicit mobile `identity-verifications:read`/`identity-verifications:write` policy applies; partner/web actors cannot use them. The existing mobile access probe still advertises its original `quotes:create` operation. Cookies are rejected. Identity derives ownership from authentication; input cannot choose client, expiry, verdict or retry limit.

Writes require an `Idempotency-Key` of 1–128 characters from letters, digits, `.`, `_`, `:`, `-`, and strict JSON limited to 4 KiB. The gateway preserves that bound before its Service Binding. Case IDs are UUIDv4 and optimistic versions are positive safe integers. Unsupported fields/methods, malformed JSON and corpus/path/query substitutions fail explicitly. Responses use `no-store`, `nosniff` and a canonical `X-Trace-Id` matching JSON. Active v1 adds no deprecation notice.

Errors distinguish 400 invalid input, 401 invalid/revoked/expired authentication, 403 denied policy, opaque 404 absent/foreign resource, 409 conflict/inactive consent/incomplete steps/outdated terms, and 503 unavailable infrastructure/provider. A 503 `verification_unavailable` includes committed verification; `access_unavailable` does not imply no commit. Required generic authentication/ownership/consent denials are durably recorded; failed denial recording returns 503. Errors never contain upstream exceptions or credentials.

## Transactions and recovery

`IdentityVerifications` coordinates ports; `SqlIdentityVerifications` owns SQL, `KycProvider` translates/bounds replies, and HTTP is injected. Composition supplies the existing `CONSENT_SEAL_KEY`, SQL binding and deterministic source. Apply Identity migration `0009_identity_verifications.sql` and runtime grants before publishing the Worker; see [migration operations](../../infrastructure/migrations.md). No new service/resource/secret is required.

Each owner transaction locks authenticated session/client, then owned case/command. Fresh `clock_timestamp()` after lock waits enforces session expiry, consent validity and result currency. HMAC-SHA-256 seals canonical state/commands: JSONB key reordering is harmless, tampering fails closed. Each business change commits state, command, shared decision capture, audit and outbox together. No transaction spans a provider call. Only serialization error `40001` retries, at most twice; network/commit uncertainty is never silently replayed by SQL.

Evaluation commits an immutable intent with UUID, inputs, original key/version and database time. The provider runs outside SQL; a fresh transaction verifies current consent/session and matching intent before finalizing once. Revocation/expiry wins over a late positive reply. Concurrent requests may repeat deterministic synthetic calculation with the same evaluation UUID, but commit one logical final result/audit/outbox. This is not exactly-once transport or a guarantee for a future effectful provider.

Keys are unique per owner across commands. Reusing a key with another action/case/payload returns conflict. Confirmed replay returns current authoritative state, including subsequent expiry/revocation; it cannot restore an old approval. Lost responses retry identical bytes/key. `pendingEvaluation` exposes only the owned opaque intent reference, key and original expected version for recovery after restart. No automatic background recovery is implemented; the user resumes explicitly.

Revocation/observed expiry clears reusable state; a replacement retires the old current marker. Minimal historical captures preserve actual synthetic inputs, consent/rule versions and outcome. Audit uses the owner's existing 90-day retention metadata; no legal retention guarantee is introduced. Runtime cannot delete records. Cleanup and onboarding notification publication require a separate operator/consumer; existing security publication does not publish these business events.

## Mobile integration and verification

The signed-in welcome action opens `/identity-verification`. Feature state holds safe DTOs and pending commands. Its HTTP adapter uses the authenticated-session execution port; tokens never enter screens or observable KYC state. That port serializes with login/refresh/logout, refuses locked callers and discards stale results after backgrounding/account changes/logout. Business conflicts do not become authentication failures. A locale change remounts the feature; persisted consent keeps its original language/hash.

The coordinator restores server state, blocks duplicate taps, retains keys/bodies after uncertain outcomes and reconciles conflicts before another action. Definite provider failure with saved verification allows a new manual evaluation key. The UI labels simulation and offers no certificate/business unlock.

Run from the repository root:

```sh
npm run test:identity-verification
npm run test:identity-verification:sql
npm run test:mobile
npm run test:pact
npm run lint:openapi
npm run check
```

The SQL suite requires the [local infrastructure](../../infrastructure/README.md). It creates/removes only a generated test database, applies migrations/least grants, and verifies transactions, concurrency, ownership, retained steps, assistance, retries, late revocation, expiry, state/command seals and fresh session time after lock waits. Unit/HTTP/Pact tests explicitly double SQL/WorkOS and do not prove deployed/native behavior. Verify dev's real gateway and device/emulator flow, both languages, background/resume, expiry, revoked sessions and interrupted requests. Export/build/Pact/SQL success alone is not native journey evidence.
