# Claim report

Policy, Claims & Payments owns the customer's report of a claim from the native app. [OpenAPI](../../../packages/contracts/openapi/v1/claims.yaml) and [synthetic examples](../../../packages/contracts/examples/claims.json) define three routes; the report ends as an open claim in the [claims inbox](claims-inbox.md). Reporting from the web channel and resuming an interrupted upload are separate work and are not part of this guide.

## Flow

A report is three owner-side steps, so a partial failure can never claim that the case was received.

| Step | Route | Result |
| --- | --- | --- |
| Draft | `POST /api/v1/claims` with `Idempotency-Key` | A draft that the inbox does not list, with the declared files as `pending`. |
| Files | `PUT /api/v1/claims/{claimId}/evidence/{fileId}` | The file is stored, its SHA-256 is verified and it becomes `verified`. |
| Submission | `POST /api/v1/claims/{claimId}/submit` | The single case number `SIN-YYYY-NNNNN`, the state `unassigned`, and the claim appears in the inbox. |

The draft declares the policy, the event type (`collision`, `theft`, `damage`, `other`), the time of the event, an optional place of at most 120 characters, a description of 40 to 600 characters and the evidence manifest: for each file a client-chosen UUID, its content type, its size and its SHA-256. The server rejects unknown fields and reports only the names of invalid fields, never their values, because a description or place may be personal data.

- **Limits.** At most 10 files and 50 MiB in total; `image/jpeg`, `image/png`, `image/heic`, `video/mp4` and `video/quicktime`. These are provisional product values taken from the approved mobile prototype, and the app checks the same limits before sending.
- **Policy.** It must be issued and belong to the caller; a policy still pending has no coverage, so a report against it answers `404 not_found` like a policy of someone else.
- **Event time.** It must not be in the future (five minutes of clock tolerance) and must fall inside the policy's effective dates, otherwise the answer is `422 outside_coverage`.
- **Required evidence.** One verified file completes a report. The submitted claim records `evidence_required = 1`; analysts may require more later.
- **Estimate.** The customer cannot value a claim, so the submitted claim has no `estimated_amount` and the inbox lists it as pending until an analyst sets one.

## Authorization and ownership

Each route calls Identity's `authorizeApiAccessV1` once, with a two-second deadline, the native user's access token and the fixed `claims:report` operation. Identity allows that operation only to a verified native session, never to the web channel or a partner, and it confers no analyst permission: [`claims:read` and `claims:decide`](../identity-consent-ecosystem/api-access.md#claims-permissions) remain explicit grants. Policy then resolves every claim through the caller's own policy (`policies.subject_token`), so a claim or file of another customer is indistinguishable from a missing one and answers `404 not_found`.

## Idempotency and failure

- **Draft.** The key and a hash of the canonical declaration, independent of the order of the files, are stored with the claim. The same key and declaration return the same draft with `200`; the same key with a different declaration is `409 idempotency_conflict`. Two simultaneous identical requests create one draft, because the unique `(policy_id, idempotency_key)` conflict is retried and then resolves to the committed row.
- **Files.** The body is the file. Its content type and `Content-Length` must equal the manifest, and R2 verifies the declared SHA-256 while it receives the stream, so a corrupted upload stores nothing (`422 checksum_mismatch`). The object is written first and recorded afterwards because SQL and R2 share no transaction; repeating an upload replaces the object with identical bytes. A file already `verified` is acknowledged again, including after submission, so a client that lost the answer can repeat it. A claim that is no longer a draft refuses a pending file with `409 claim_not_draft`.
- **Submission.** It locks the claim, requires every declared file to be `verified`, takes the next number from `claim_number_counters` (one row per Bogotá calendar year, updated in the same transaction) and writes the audit event. A missing file answers `409 evidence_incomplete` with the ids still missing. Repeating the call returns the same number; serialization conflicts are retried as a whole. A failed audit write rolls back the number and leaves the draft untouched.
- **Unprovisioned storage.** Where the Worker has no evidence bucket binding, as in prod today, the upload answers `503 evidence_unavailable` and nothing is acknowledged.

`policy.audit_events` records `claims.report.draft`, `claims.report.evidence` and `claims.report.submit` with the client id as the actor and the claim as the resource, retained for a provisional 90 days. Evidence rows are retained for a provisional 365 days.

## Evidence storage

Objects are written to the private R2 bucket bound as `CLAIM_EVIDENCE` under the key `claims/{claimId}/{fileId}`; the bucket is created per environment by `infra:<environment>:storage` (see the [operations guide](../../infrastructure/README.md)). Dev and staging bind their own bucket and expire objects after 30 days because they hold synthetic data only, while the SQL retention is longer. Nothing in the bucket is public.

The web Worker forwards the JSON routes with a 32 KiB body limit and the five-second budget of the other small routes. It streams an evidence upload to Policy without buffering it, requires a `Content-Length` of at most 50 MiB and allows 120 seconds; Policy authenticates before reading the body.

## Data

Migration `0010_claim_report.sql` adds `event_type`, `event_place`, `description` and `submitted_at` to `claims`, `client_file_id` to `evidence_metadata` with a unique `(claim_id, client_file_id)` index, and the `claim_number_counters` table. The runtime role gains `SELECT`, `INSERT` and `UPDATE` on the counters only; it still cannot delete claims, evidence or audit rows. A draft is a `claims` row with `status = 'draft'`, which is not an open state, so the inbox never lists it. The parametric payment flow keeps its original insert statement.

## Verification

`npm run test:financial` includes `tests/claim-report.test.ts`: the declaration rules, the request hash, the whole flow with an in-memory store that copies the store contract, every refusal over HTTP validated against the OpenAPI schemas, and the gateway carrying the JSON and streaming the bytes intact. `npm run test:claim-report:sql` uses a generated disposable local database with the real migrations and runtime grants to check ownership, idempotent replay, simultaneous identical requests, distinct consecutive numbers under simultaneous submissions, audit rollback, runtime privileges, constraints and that the inbox lists the submitted claim without an estimate. Neither run reaches R2: the bucket binding, the checksum verification by R2 and the streaming through two Workers are not exercised by them.
