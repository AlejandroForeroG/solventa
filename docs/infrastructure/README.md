# Infrastructure operations

## Local

Requires Node 22.21.1, npm 10.9.4 and Docker with Compose. From the repository root:

```sh
npm ci
npm run infra:up
npm run check
npm run test:infra
npm run dev:backend
```

Compose uses CockroachDB 26.2.0, one node and a persistent volume. An initialization process generates the CA/certificates; the node and clients verify TLS. Only `127.0.0.1:26258` (SQL) and `127.0.0.1:8088` (HTTPS console) are published. The console uses the local CA and requires administrative credentials. `infra:up` is repeatable: it applies pending migrations and preserves passwords/data.

`infra:down` stops containers without deleting the volume. Certificates, passwords, local Wrangler configurations and the diagnostic token are Git-ignored. Preserve `infra/.local` with the volume; losing passwords requires administrative recovery. Do not share these files or use them in production.

The `solventa_local` database has three logical owners:

| Backend | Schema | Binding |
|---|---|---|
| acquisition-risk | acquisition | ACQUISITION_DB |
| identity-consent-ecosystem | identity | IDENTITY_DB |
| policy-claims-payments | policy | POLICY_DB |

Each runtime role can read its migration ledger; it cannot query other schemas or create tables. The provisioner uses a separate administrative connection. Future migrations must explicitly grant minimum table DML to the owning role; never DDL or privileges on another owner. `infra:verify` checks permissions through real queries.

Each backend keeps SQL in `migrations/`. See [data model](data-model.md) for tables and [migration procedures](migrations.md) for creation, permissions, validation, application and recovery. An environment not yet promoted may have fewer applied versions.

`test:infra` temporarily starts four Workers on 8790 and checks SQL, RPC, missing/invalid token rejection, web assets and disabled business routes. The local token is generated in `apps/web/.dev.vars`; it is not printed. `/health` is liveness; `GET /internal/infra` requires `Authorization: Bearer <DEV_INFRA_TOKEN>` and returns 503 if a dependency is unavailable.

## Cloudflare and CockroachDB: dev, staging and prod

The configured account is `803fd559877aae8f638140610f106857`. The expected Wrangler profile is `solventa-universidad`; another authorized profile may be selected with `CLOUDFLARE_PROFILE`, but the target account stays fixed. Authenticate with `wrangler login --profile solventa-universidad`.

Each environment reads only its ignored local file `.env.infra.dev`, `.env.infra.staging` or `.env.infra.prod`, containing administrative `DATABASE_URL` and the cluster CA's `DATABASE_CA_FILE`. This public CA is registered in Cloudflare to verify the origin. Do not copy client certificates or local-environment credentials. The provisioner uses the administrative URL to create the corresponding database, schemas and roles. It never inherits variables from another file or defaults to a remote environment. It neither creates nor changes the cluster plan.

| Environment | Database | Workers | Hyperdrives | Use |
|---|---|---|---|---|
| dev | solventa_dev | 4 | 3 | Development integration |
| staging | solventa_staging | 4 | 3 | Candidate validation |
| prod | solventa_prod | 4 | 3 | Final deployment foundation |

All three currently share one CockroachDB Basic cluster. Each database revokes public access and each `solventa_<environment>_<owner>` role has privileges only on its schema. Workers, bindings, SQL users and diagnostic secrets belong to one environment. The public CA can be reused because it verifies the same origin. A shared cluster means shared resources/failures.

Each environment has a designated provisioner. Other developers use local environments and need no administrative credentials. The provisioner keeps an encrypted copy outside Git of `infra/.local/runtime.<environment>.json`, `infra/.local/web.<environment>.secrets.json` and `infra/.local/identity.<environment>.secrets.json` in the team's authorized secret store. Git is not a backup of those files. Identity configuration contains environment-specific WorkOS/cookie keys; see [authentication](../modules/identity-consent-ecosystem/authentication.md).

When moving machines or adding an operator, restore all three environment files under `infra/.local` with user-restricted access before running commands. If SQL users already exist but state is missing, preflight returns `runtime_state_missing` before modifying the database or Hyperdrives. If the web secret or Identity configuration is absent, deployment fails before publishing Workers. Recover original state from custody and retry. Permanent loss requires coordinated administrative recovery; scripts do not automatically rotate credentials. Do not run concurrent provisioners on the same environment.

```sh
npm run infra:dev:up
npm run deploy:dev
npm run infra:dev:verify

npm run infra:staging:up
npm run deploy:staging
npm run infra:staging:verify

npm run infra:prod:up
npm run deploy:prod
npm run infra:prod:verify
```

`infra:<environment>:up` applies migrations, checks isolation, creates/updates only that environment's Hyperdrives and stores their IDs in its configuration. Each Hyperdrive uses its own role, disabled caching, TLS `verify-full` and a five-origin-connection limit. The provisioner does not print URLs, passwords or Cloudflare tokens. Administrative credentials are never bound to a Worker. Before mutation, validation rejects crossed bindings, shared IDs and public backends.

Deployment publishes Identity and Policy first, then Acquisition and finally web. It generates a persistent random secret in `infra/.local/web.<environment>.secrets.json` and uploads it with `--secrets-file`. Although the variable is still called `DEV_INFRA_TOKEN`, its value differs per environment. Backends have `workers_dev: false` and `preview_urls: false`. Only web has a public address: assets/liveness are public and diagnostics require the secret. Its address is stored locally in `infra/.local/<environment>-endpoint.json`.

Remote checks validate Hyperdrive configuration, SQL through Workers, RPC, diagnostic permissions and private backend exposure. They also require all three services to report the correct environment/database. `infra:<environment>:verify` checks denied SQL reads to other schemas and both other remote databases, so all three databases must exist. It does not measure latency, resilience, alerts, PCI compliance or comprehensive security.

CI validates code, packaging of all twelve Workers and local infrastructure without remote credentials. CD repeats checks, publishes the selected environment's four Workers, verifies SQL/RPC and cleans sensitive files. Follow [Gitflow and CI/CD](ci-cd.md) to test the integration branch in dev, promote its base to staging and publish releases to prod. Provision resources separately; do not copy data, secrets or IDs between environments. CD verifies schema with runtime roles before publication. The [migration guide](migrations.md) centralizes administrative candidate application/recovery; CD neither creates users nor applies remote DDL.

Web authentication has its own [guide and limits](../modules/identity-consent-ecosystem/authentication.md). Business capabilities, PII handling, recovery and alerts require implementation/validation before enabling the product for real users.

References: [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/), [Hyperdrive and TLS](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/), [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
