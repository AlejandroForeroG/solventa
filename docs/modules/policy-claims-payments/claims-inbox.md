# Claims inbox and case file

Policy, Claims & Payments owns the operational workspace at `/siniestros` and the customer workspace at `/mis-siniestros`. The [OpenAPI contract](../../../packages/contracts/openapi/v1/claims.yaml) and [synthetic examples](../../../packages/contracts/examples/claims.json) describe the same case and evidence managed by the [native claim report](claim-report.md). The web gateway routes the exact `/api/v1/claims` prefix to Policy after the version gate and forwards report and response files as streams.

## Access and audit

The sealed WorkOS web session is verified by Identity's `authorizeApiAccessV1` on each request within two seconds. The [claims grants](../identity-consent-ecosystem/api-access.md#claims-permissions) are separate. `claims:read` lists open claims and opens case files. `claims:decide` takes an unassigned case and authorizes actions on the analyst's assigned cases. The authenticated policyholder uses `claims:respond` with an ownership check in Policy. Neither channel supplies actor identifiers. Partners and native users cannot use these web operations.

The inbox is operational and lists summary rows across customers. An unassigned case shows the case header and the option to take it. Its description and documents remain protected until assignment. The analyst cannot take or decide a claim from their own policy, access another analyst's case file, or replace an existing assignee. Customer routes match the policy subject, and hide operational history. Unavailable authorization, expired analyst leases, or failed audit writes prevent success. Inaccessible cases and evidence return an opaque 404. Responses and audit events carry a correlation UUID. Protected responses are never cached.

## Inbox and evidence

`GET /api/v1/claims` returns twenty open cases per page. It orders by priority, age, estimated amount (null last), and stable id. Use the returned id as `before`, preserving filters. The accepted filters are `state`, `overdue=true` and an exact claim number or policy UUID as `query`. Priority is high at five Bogotá calendar days or upon escalation, medium from two through four days and low otherwise. The five-day threshold also defines overdue.

Case evidence is linked to the existing `evidence_metadata` record. Only verified, unexpired evidence attached to the report or a received response appears in the document tab. Download resolves the metadata and authorizes against the same case before opening the private R2 object. Object size and SHA-256 metadata must agree with SQL, and the response is a download with the original media type. Unavailable or inconsistent storage returns a correlated 503.

## Case actions

- **Take case** assigns the authenticated analyst and moves a filed unassigned case into review. Assignment and the fact that the case was taken are recorded together.
- **Approve or reject** requires a reviewable case, a trimmed reason of 10–1000 characters, and a selection of one to twenty verified evidence records from that same case. The required evidence count must also be met. The decision preserves its inputs, actor, prior and resulting states, versioned capture, reason and audit. It creates no indemnity or payment.
- **Assign expert** requires a reason and a valid expert from the shared [simulated assistance directory](assistance-provider-search.md). The assignment creates an escalated case and a peritaje task with the expert, reason, analyst and date. It leaves approval and payment as independent actions.
- **Request information** states what the policyholder must provide and the future deadline. A single outstanding request moves the case to pending information and is visible to both participants. The web form displays the deadline in Bogotá time.
- **Respond** is available to the policyholder before the deadline. A response may contain text, verified files, or both. A request accepts at most three files and 50 MiB from the same report media types. A successful response links the submitted evidence to its request and case, records the text and timestamp, and brings the case back into review. It is not a decision.

Writes are serializable. The case transition, action or decision, audit and participant notices commit together. The command key is scoped to the actor and case, hashed at rest, and bound to the canonical command. An exact retry returns the original outcome; changing the command with the same key returns 409. Evidence uploads retain their own stable file UUID and checksum across retries. The object is written to R2 before Policy marks the evidence verified, and the verified object becomes visible in the case only when the response commits. R2 and SQL have separate failure boundaries.

Customer and analyst notices are rendered in their case file. Expert assignment writes a durable notice to the simulated expert recipient's inbox in Policy. It does not send real email or push. The `claim.decided` outbox additionally records the decision for future consumers. The customer view does not deliver native tracking or native requirement responses.

## Data and verification

Migration `0009_claims_inbox.sql` added the case number, assignment, estimated amount and evidence requirement. Migration `0010_claim_report.sql` added the event data and claim number counter for real reports. Migration `0016_claim_decisions.sql` adds decision and action history, requirements, response evidence association and participant notices. SQL uses only the Policy schema and minimum runtime grants. See the [migration guide](../../infrastructure/migrations.md) for provisioning and verification.

```sh
npm run test:financial
npm run test:claims:sql
npm run test:web
npm run test:pact
```

The SQL suite creates a disposable local database and checks authorization, decisions and replays, requirement linkage, expert assignment, notices and the lack of an automatic payment. In dev and staging, provision separate synthetic customer and analyst sessions. Grant the analyst both permissions using the Identity operator, and use the customer session that owns the filed claim for the response. Validate assignment, evidence download, the information request and response, expert escalation and a reasoned decision. Tests of SQL metadata do not establish a verified transfer from R2.
