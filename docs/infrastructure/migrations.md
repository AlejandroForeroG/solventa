# Creating, applying and recovering migrations

Run commands from the repository root. The runner is [infra/database.mjs](../../infra/database.mjs); [schema-verify](../../infra/schema-verify.mjs) compares the revision with the actual schema. The migration job uses environment-bound administrative configuration held in GitHub Environment secrets. PR validation and Worker publication use no administrative connection. An operator remains responsible for bootstrap and reconciliation.

## 1. Preparing the change

Create the candidate branch from staging and, when needed, a separate integration branch following [Gitflow](ci-cd.md). Identify the owner and read its complete migrations, data model and affected consumers.

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

## 4. Automatic application per environment

The migration utility is [infra/migrations.mjs](../../infra/migrations.mjs). It reuses the existing version/checksum ledger, durable failure guard, SQL executor and runtime-grant reconciler. It does not create databases/users, rotate passwords or provision Cloudflare resources. Bootstrap an environment separately using the existing provisioner before its first automatic deployment.

From the exact candidate checkout, inspect one explicit environment at a time:

```sh
npm run db:migrations -- status local
npm run db:migrations -- status dev
npm run db:migrations -- status staging
npm run db:migrations -- status prod
```

Each status command uses that environment's ignored administrative configuration in a READ ONLY transaction. It lists applied and pending filenames separately for all three owners, validates recorded checksums, rejects versions missing from the checkout, out-of-order history, pending failure guards, unexpected tables and objects in public. Status never executes SQL migrations or changes permissions. The legacy `node infra/migration-plan.mjs <environment>` command delegates to the same status implementation. A missing database/ledger is a bootstrap error, not an empty history.

To apply an authorized revision manually, use `npm run db:migrations -- apply staging`, replacing the environment consistently. Restore its original `.env.infra.<environment>`, referenced CA and `infra/.local/runtime.<environment>.json` from custody first. Never reuse another environment's bundle. The utility loads a fixed SQL/grants catalog, preflights every owner before its first write, applies only unrecorded versions in order, reconciles minimum runtime grants and verifies the resulting plan, complete administrative/runtime catalog, checksums, guards, empty public schema and runtime isolation. Rerunning skips recorded SQL; grant reconciliation converges after interruption. It reports before/after inventories and the applied filenames without connection strings, passwords or data.

### Deployment sequence

Every push to dev, staging or prod runs the existing Deploy workflow:

1. Resolve the environment from the protected branch and run full CI on the exact deployment SHA, without remote administrative credentials.
2. Run the separate `migrate` job on a fresh runner, using that GitHub Environment. Restore only migration configuration, CA and original runtime state; execute `db:migrations -- apply <environment>`; remove the temporary files even after failure.
3. Only after successful migration and verification, run the separate `deploy` job. It restores runtime/publication credentials, checks the remote schema, publishes the four Workers and executes SQL/RPC/isolation smokes. It never receives the migration URL.

Migration is automatic after integration and **before Worker publication**. This replaces the former manual pre-merge application requirement. Branch PR/CI requirements, conversation resolution and applicable human approvals remain in force. Migration does not mean that a business journey or an entire story passed acceptance.

The workflow serializes deployments per environment with cancellation disabled. Do not run an operator/provisioner concurrently with Deploy. The durable per-version guard prevents replay after interrupted DDL, including cases where ledger DML committed. Automation never clears a guard or rewrites an applied migration. A failure in migration, grant reconciliation or verification blocks publication. Retrying a completed migration skips its SQL. CockroachDB DDL/grants can survive rollback; use section 5 for partial execution rather than retrying blindly.

### Credential setup

Set `MIGRATION_DATABASE_URL` as an encrypted secret in each authorized GitHub Environment, not a repository/global variable. Use an authorized SQL migration identity and an explicit URL of the form `postgresql://<operator>:<password>@<configured-host>:<port>/solventa_<environment>?sslmode=verify-full`. Keep its original credential in authorized custody. This utility does not create or rotate that identity.

The migration restore validates the exact branch, environment database, configured host/port, runtime-state database and public CA before writing files. It rejects client-certificate paths, TLS overrides and crossed environments. Verified TLS is mandatory. `DATABASE_CA_PEM`, `RUNTIME_STATE_JSON`, `DATABASE_HOST` and `DATABASE_PORT` already belong to that Environment. Credentials are available only to the environment's matching branch; no PR receives them. See [CI/CD configuration](ci-cd.md#github-configuration).

Temporary migration files are private and cleaned on success/failure, with a manifest so cleanup does not remove unrelated operator files. Secrets are not logged, uploaded as artifacts or bound to a Worker. A secret's environment label and URL check do not narrow the SQL identity's server-side privileges: restrict those privileges in CockroachDB where possible. If the custodied identity has cluster-wide administrative access, trusted workflow code can exercise that access; this is a deployment trust boundary, not cross-environment credential isolation enforced by the URL.

The SQL files must remain compatible with the currently deployed Workers during the migration/publication window. Expand first and remove obsolete structures only in a later compatible release. A failed publication does not roll back SQL, and an older checkout with missing applied versions is rejected. Staging applies only its tested candidate's migrations; prod applies only its approved staging release. No environment copies another's data.

## 5. Failures, reconciliation and rollback

The runner persists intent in `<schema>.schema_migration_failures` **before** DDL. It keeps `autocommit_before_ddl=on`: `BEGIN/ROLLBACK` does not guarantee atomicity of the complete file or ledger with its DDL statements. The guard is removed only after successful completion. Connection loss, COMMIT failure or intermediate error may leave partial structure even when the ledger contains a checksum.

On `migration_reconciliation_required`, stop execution and reconcile administratively. Never retry blindly, edit recorded SQL, disable the global setting or remove the marker as the first step.

1. Identify environment, owner, version, checksum and technical cause without exposing secrets.
2. Inspect marker, ledger, `SHOW CREATE TABLE <schema>.<table>` and `SHOW CONSTRAINTS FROM <schema>.<table>` for each affected object; confirm which statements persisted.
3. If schema and ledger are complete, preserve them and remove only the reconciled marker through an authorized administrative operation. If incomplete, repair structure and recording in a controlled manner before removing that marker. Document intervention outside the product; do not automate generic guard deletion.
4. Reconcile pending grants where applicable and rerun administrative/runtime and isolation checks. `GRANT/REVOKE` can also survive rollback.

Worker rollback does not revert SQL or data. Prepare a new revision compatible with the applied schema, preserve files/checksums and promote through PR. Deploying an old SHA whose catalog no longer matches fails the gate; do not delete versions to force it.

Model details are in [SQL model](data-model.md). [CockroachDB's official schema-change documentation](https://docs.cockroachlabs.com/docs/stable/online-schema-changes#schema-change-ddl-statements-inside-a-multi-statement-transaction-can-fail-while-other-statements-succeed) explains the DDL limitation in multi-statement transactions.
