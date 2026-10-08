# Development

TypeScript monorepo with web and mobile applications and three independent backends.

| Path | Component |
|---|---|
| apps/web | React and Vite; assets Worker, authentication through a binding and diagnostics |
| apps/mobile | React Native and Expo |
| backend/acquisition-risk | Acquisition & Risk |
| backend/policy-claims-payments | Policy, Claims & Payments |
| backend/identity-consent-ecosystem | Identity, Consent & Ecosystem |
| packages/contracts | Boundary contracts |
| packages/assets | Shared web/mobile brand and assets |
| infra | Operational configuration |

## Installation and checks

Use Node.js 22.21.1 and npm 10.9.4. Run from this root:

```sh
npm ci
npm run check
```

`check` checks Git/promotion policy, core dependencies, architecture tests, credentials and environment boundaries, API versioning/contracts (tests and OpenAPI lint), lint, types and builds. The mobile workspace exports for web; this does not validate native capabilities. All twelve remote Workers are packaged with `--dry-run` for dev, staging and prod. CI also starts CockroachDB with TLS and exercises real SQL and RPC through local Workers.

`npm ci` installs native Git hooks through `prepare`. `pre-commit` and `pre-push` validate the branch; `commit-msg` validates its message. Use lowercase branches `feat/<description>`, `fix/<description>`, `refactor/<description>` or `test/<description>`, with hyphens, and titles `feat|fix|refactor|test(module): description` up to 150 characters. Examples: `feat/add-login` and `feat(auth): add login`. The commit body may include more detail. Documentation, comments, tests and code identifiers use English; responses to the user use Spanish.

Create the base branch from staging, then its `-dev` partner for a PR to dev. Promote the ready base through a PR to staging; each release goes from staging to prod. Cherry-pick relevant `-dev` fixes back to the base, then synchronize and test again. Follow [Gitflow and CI/CD](infrastructure/ci-cd.md), including merge and prior deployment requirements.

## Local development

Brand SVGs and variants are in [shared assets](shared/assets/README.md). Import `brandAssets` from `@solventa/assets/web` or `@solventa/assets/mobile`; the path catalog is in `@solventa/assets`. Both channels consume the same source.

Requires Docker with Compose:

```sh
npm run infra:up
npm run build --workspace @solventa/web
npm run dev:backend
```

`dev:backend` starts the web Worker and all three services with local bindings. Open the address printed by Wrangler. Channels can run in other terminals:

```sh
npm run dev:web
npm run dev:mobile
```

Vite uses 5173 for UI editing. CockroachDB listens only on loopback: SQL 26258 and HTTPS console 8088. `/health` indicates process liveness; protected `/internal/infra` diagnostics query all three stores and use RPC between services. `npm run test:infra` checks this on 8790. `npm run infra:down` stops the environment and preserves data. Mobile requires a device or emulator to validate native capabilities.

## Reference documentation

Consult [modules and implemented state](README.md), [architecture boundaries](architecture.md) and [infrastructure operations](infrastructure/README.md) before extending a flow.
