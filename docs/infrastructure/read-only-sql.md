# Read-only SQL queries

- Run from the product root. Consult [operations](README.md) and [SQL model](data-model.md) for tables and permissions.
- Explicitly choose `local`, `dev`, `staging` or `prod`; databases are `solventa_<environment>`. Local SQL uses `127.0.0.1:26258`; remotes use that environment's configured origin.
- Configuration is in `.env.infra.<environment>` and runtime passwords in `infra/.local/runtime.<environment>.json`, both Git-ignored. The env-file URL is administrative: for data inspection, replace username/password with the `solventa_<environment>_<schema>` role. Never print files, URLs or credentials.
- Schemas are `identity`, `acquisition` and `policy`. Open a separate connection with the corresponding role per owner; never broaden permissions for cross-owner queries.
- `backend/<backend>/runtime-grants.json` describes business-table permissions. A catalog entry grants no access: `schema_migration_failures` is administrative and unreadable by runtime; `schema_migrations` does allow SELECT.
- Use `settings` and `clientFor` from `infra/database.mjs`, verified TLS and a read-only transaction. List tables first; environments may have different migrations. Query only required fields with filters/limits, avoiding PII in output.
- `npm run infra:<environment>:schema-verify` checks versions, checksums, tables and owned reads without writing. For `public` and administrative markers, an operator uses `node infra/schema-verify.mjs <environment> --admin`; never run that mode with administrative credentials in CI/CD.
- Missing configuration/credential state requires restoration from operator custody; never invent passwords or rotate users. `npm run infra:up` starts Docker and applies pending migrations: it is not an inspection command.
- Data inspection does not authorize migration, provisioning, deployment, inserts, updates or deletion, especially in staging/prod. Those operations require their own task and promotion flow.

Table-inspection example; change the final two arguments to select environment and owner:

```sh
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { settings, clientFor, owners } from "./infra/database.mjs";
const [environment, schema] = process.argv.slice(1);
if (!owners.some(owner => owner.schema === schema)) throw Error("Invalid owner");
const config = await settings(environment);
const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, "utf8"));
const url = new URL(config.url);
url.pathname = "/" + config.database;
url.username = `solventa_${environment}_${schema}`;
url.password = state.passwords[schema];
const db = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
try {
  await db.connect();
  await db.query("BEGIN TRANSACTION READ ONLY");
  const result = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", [schema]);
  console.log(JSON.stringify(result.rows));
} finally { await db.end(); }
' local identity
```
