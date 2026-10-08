# Creating, applying and recovering migrations

Run commands from the repository root. The runner is [infra/database.mjs](../../infra/database.mjs); [schema-verify](../../infra/schema-verify.mjs) compares the revision with the actual schema. Migrations require an operator with administrative configuration held in custody. CI/CD never receives that remote administrative connection.

## 1. Preparing the change

Create the base branch from staging and its integration branch following [Gitflow](ci-cd.md). Identify the owner and read its complete migrations, data model and affected consumers.

| Owner | Versioned SQL | Runtime permissions |
|---|---|---|
| Acquisition & Risk | `backend/acquisition-risk/migrations/` | `backend/acquisition-risk/runtime-grants.json` |
| Identity, Consent & Ecosystem | `backend/identity-consent-ecosystem/migrations/` | `backend/identity-consent-ecosystem/runtime-grants.json` |
| Policy, Claims & Payments | `backend/policy-claims-payments/migrations/` | `backend/policy-claims-payments/runtime-grants.json` |

Add a new file using the owner's next available number: `NNNN_description.sql`, for example `0006_clients_status_index.sql` in Identity. The runner sorts `.sql` filenames lexicographically and stores the full name as the version; coordinate numbering across concurrent branches. Sequences belong to each module, not a global sequence. Never rename, reuse or edit a file already applied in any environment.

Illustrative example; this guide neither creates the file nor applies SQL:

```sql
CREATE INDEX clients_status_lookup ON clients (status);
```

The runner selects the owner's schema through `SET search_path` on the connection. Do not create objects in `public`, foreign keys between owners or access to other tables. Do not include manual ledger control, guard cleanup or role creation in a migration. Separate structural changes from significant backfills; specify execution, resumption and validation before implementing a backfill.

Preserve compatibility with code that will keep running during the change: expand the schema first, publish consumers next, then remove obsolete structures in a later delivery once their dependencies are gone. Review existing data, nullability, defaults, constraints, duplicates, cardinalities and index impact; do not derive financial rules from DDL convenience.

## 2. Permissions, tests and documentation

When creating a business table, add it to the owner's `runtime-grants.json` with the minimum required `SELECT`, `INSERT` and/or `UPDATE`. Runtime cannot receive `DELETE`, DDL, `ALL`, cross-owner access or writes to `schema_migrations`. `schema_migration_failures` is administrative and is not listed in that file.

The verifier derives the expected catalog from grants plus ledger and guard. Omitting a new table from grants also fails comparison; deliberately define its access before adding it to the current model. Grants are reconciled through differences after validating all tables, without `REVOKE ALL` on runtime. They are not atomic: failure may leave partially applied permissions requiring convergence/verification.

Update the module's data guide and [relevant tests](../testing.md). Test new constraints/invariants with synthetic data: valid cases, invalid rejection, fresh installation, unchanged replay and minimum permissions. Existing infrastructure SQL tests are in [schema-smoke](../../infra/schema-smoke.mjs); test business rules in their domain/use case rather than replacing them with DDL tests.

## 3. Local validation

Requires project Node/npm, Docker and local state compatible with the revision. Do not connect an old checkout to a volume containing future migrations and delete versions to force agreement; preserve data and use an isolated local environment if the branch needs another schema line.

```sh
npm ci
npm run check
npm run infra:up
npm run test:schema
npm run infra:local:schema-verify
node infra/schema-verify.mjs local --admin
```

`infra:up` starts Docker, applies pending migrations and prepares local roles/bindings. `test:schema` performs fresh installation in a temporary synthetic database and checks replay, catalog, constraints and isolation; it removes only that generated database. Its persistent-database probes use synthetic transactions with rollback. If authentication/service integration is affected, also run `npm run test:authentication:sql` and `npm run test:infra` as appropriate.

First application records version, checksum and timestamp in `<schema>.schema_migrations`. New checksums normalize LF; equivalent historical CRLF checksums are accepted without rewriting the ledger. Any other modification of applied SQL fails. Repeating the runner normally skips recorded versions; a pending guard blocks the owner's complete replay.

## 4. Applying per environment before integration

Administrative application requires an authorized task and the final candidate approved for that environment. Freeze locally/CI-tested SQL; apply it from that checkout before integrating code that needs it. If the candidate is corrected after SQL application, preserve it and add another migration.

### Running migrations as a teammate

Any designated teammate with the approved candidate checkout and the environment's authorized operator bundle can run the existing provisioner. The privilege belongs to the operator credentials, not to a particular person's laptop or GitHub account. Obtain the bundle through the team's authorized secret channel; Git, PR comments, CI logs and chat messages must not carry the administrative URL or runtime passwords. Do not reuse another environment's bundle. A remote runtime role cannot apply DDL; each developer can apply the candidate migrations to their own local environment with `npm run infra:up`.

From the repository root of the **exact candidate branch** to be deployed:

1. Install locked dependencies with `npm ci`, update the local environment with `npm run infra:up`, then run the branch's required tests, including `npm run test:schema` and `npm run infra:local:schema-verify`. Read and review its new owner SQL and `runtime-grants.json` before touching a remote environment.
2. Restore `.env.infra.dev`, its referenced CA file and `infra/.local/runtime.dev.json` from the approved dev bundle. On another environment, replace every `dev` occurrence consistently. These files must remain ignored with user-restricted access. The runtime state is required even for a SQL-only provision because existing roles must keep their original passwords.
3. Coordinate a single operator for that environment. Run `node infra/migration-plan.mjs dev`: it opens an administrative **READ ONLY** transaction, checks all three ledgers and guards against the checkout, and prints only applied counts and pending file names. It never prints URLs, passwords or checksums. Review the affected objects and permissions against the candidate. Stop on a guard, unexpected object or changed applied checksum and use section 5.
4. Run `node infra/database.mjs provision dev`, then `node infra/schema-verify.mjs dev --admin` and `node infra/database.mjs verify dev`. The provisioner applies pending migrations and reconciles runtime grants for **all three owners** in that environment; inspect their directories before running it. A repeat with the same applied checksums skips those migrations.
5. Record the environment, candidate commit, applied migration names, verification outcome and operator in the team's private operational record. Then finish the PR, CI and Deploy checks. The Deploy job itself does not apply DDL.

For the current Acquisition quote candidate, the pending files are `0006_partner_quotes.sql`, `0007_user_quotes.sql` and `0008_quote_idempotency_by_actor.sql`. They add a quote-code counter and actor-scoped idempotency; the `quote_counters` runtime grant is part of the same candidate. Apply from that candidate before integrating its Worker code. Repeat the process in staging only when promoting the tested base branch. A deployment on dev does not migrate staging.

Restore `.env.infra.<environment>`, the CA and `infra/.local/runtime.<environment>.json` from custody. See [access and custody](README.md) and [read-only queries](read-only-sql.md). Never print administrative URLs or secrets. If users are provisioned without their runtime state, `runtime_state_missing` stops the process: restore the original rather than inventing passwords.

Before mutation, inspect ledger, catalog and guards through an administrative READ ONLY connection to the environment. Distinguish expected pending-migration differences from changed checksums, unexpected objects or partial execution. Do not use `schema-verify` as a preflight requiring the new version to be already applied: strict comparison is necessary **after** application.

For SQL only, an operator uses these commands, one environment at a time according to authorization:

```sh
node infra/database.mjs provision dev
node infra/schema-verify.mjs dev --admin
node infra/database.mjs verify dev
```

Replace all three `dev` arguments with `staging` or `prod` for the corresponding promotion. `provision` visits all three owners, applies pending migrations and reconciles permissions; its CLI selects neither a single migration nor a single owner. For SQL-only changes, this avoids reprovisioning Hyperdrive. `infra:<environment>:up` also changes Cloudflare resources and is reserved for infrastructure changes requiring it.

After administrative verification, integrate the PR and wait for successful Deploy. CD checks schema, versions, checksums and permissions with runtime roles before publishing; it also checks remote SQL/RPC and isolation. Additional administrative verification confirms empty `public` and guards. Local CI does not establish remote application.

Under current Gitflow, dev may contain migrations from several features. Staging receives only migrations present in the base-branch candidate tested through its `-dev` branch; prod receives the staging release's migrations. Do not copy data or credentials between environments.

## 5. Failures, reconciliation and rollback

The runner persists intent in `<schema>.schema_migration_failures` **before** DDL. It keeps `autocommit_before_ddl=on`: `BEGIN/ROLLBACK` does not guarantee atomicity of the complete file or ledger with its DDL statements. The guard is removed only after successful completion. Connection loss, COMMIT failure or intermediate error may leave partial structure even when the ledger contains a checksum.

On `migration_reconciliation_required`, stop execution and reconcile administratively. Never retry blindly, edit recorded SQL, disable the global setting or remove the marker as the first step.

1. Identify environment, owner, version, checksum and technical cause without exposing secrets.
2. Inspect marker, ledger, `SHOW CREATE TABLE <schema>.<table>` and `SHOW CONSTRAINTS FROM <schema>.<table>` for each affected object; confirm which statements persisted.
3. If schema and ledger are complete, preserve them and remove only the reconciled marker through an authorized administrative operation. If incomplete, repair structure and recording in a controlled manner before removing that marker. Document intervention outside the product; do not automate generic guard deletion.
4. Reconcile pending grants where applicable and rerun administrative/runtime and isolation checks. `GRANT/REVOKE` can also survive rollback.

Worker rollback does not revert SQL or data. Prepare a new revision compatible with the applied schema, preserve files/checksums and promote through PR. Deploying an old SHA whose catalog no longer matches fails the gate; do not delete versions to force it.

Model details are in [SQL model](data-model.md). [CockroachDB's official schema-change documentation](https://docs.cockroachlabs.com/docs/stable/online-schema-changes#schema-change-ddl-statements-inside-a-multi-statement-transaction-can-fail-while-other-statements-succeed) explains the DDL limitation in multi-statement transactions.
