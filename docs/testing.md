# Tests that protect functionality

Write unit tests to protect rules, contracts or behavior that code changes could break. Choose them by actual use-case risk, not count or percentage. Documentation changes or reversible moves without changed behavior do not need artificial unit tests.

## Designing a test

- Describe an input/state and observable result: value, error, valid transition or required effect. The test must fail when behavior breaks, even if function names remain unchanged.
- Cover the valid case and relevant boundaries: empty/invalid data, numeric/time boundaries, denied authorization/consent, duplicates, concurrency conflicts and failed dependencies when present in the flow.
- Keep synthetic data small and deterministic. Inject clocks, repositories or providers when needed; do not depend on wall-clock time, networking, other tests' ordering or sleeps to validate rules.
- Use in-memory ports in Domain/Application and HTTP tests. Do not mock the function under test; isolate only its dependencies. Unit tests must not require Docker.
- Avoid assertions on private variables, trivial calls, huge snapshots, mocks repeating implementation and tests written solely to increase coverage. Verify interactions when they form a guarantee, such as never calling a provider with invalid consent.

## When functionality changes

Update unit-test expectations with the intentional behavior change and its documentation. Add a regression test when fixing an error; retain tests for rules that still apply. Never delete or weaken a test merely to turn CI green: determine whether it reveals a regression or changed requirement, and explain the change in the PR.

For example, when a calculation rule changes, test inputs and results for the new version, preserve historical decision interpretation and check that the capture records the actual applied version. When a route changes, update contractual responses/errors and preserve authorization/versioning guarantees.

## Choosing the layer

| Layer | Check | Dependencies |
|---|---|---|
| Domain | Rules, invariants and boundaries | Own values, no platform |
| Application | Orchestration, errors, consent, idempotency and decision capture | In-memory ports |
| HTTP/contract | Input, status, response and OpenAPI/Pact compatibility | `createHttp(deps)` without real SQL |
| SQL adapter | Constraints, persistence/transactions, catalog and permissions | Real local/temporary database |
| Integration | Bindings, coordination and errors between services | Local Workers and SQL |
| E2E/native | User flow and device capabilities | Real browser/device |

An in-memory repository test does not establish a SQL transaction. A mobile build/export does not establish biometrics or secure storage. Remote smoke does not establish the complete business flow.

## Execution and maintenance

Use the existing runner: `node --test` for `.mjs` tools and `tsx --test` for TypeScript suites. Integrate relevant new suites into module/root scripts and `npm run check`; do not leave tests unexecuted in CI. Consult actual [package.json scripts](../package.json). Write test descriptions and identifiers in English.

Run the affected suite first, then `npm run check` for code changes. [Migrations](infrastructure/migrations.md) and SQL adapters require their additional real tests. Once appropriate checks pass, do not repeat or broaden testing without a new change, failure or uncertainty that justifies it.

The CI `validate` job runs the authentication, partner-access, quote and consent SQL suites after starting its local database and checking fresh migrations. Each suite is mandatory: a missing script or file, or a failing assertion, fails CI. These steps also run in post-merge Deploy through the reusable CI workflow and use only local synthetic data, without remote administrative credentials. The final schema and SQL/RPC checks run afterwards, and container shutdown runs even after a failure.

In the PR, link new/updated documentation and state the behavior each relevant suite protects, executed commands and actual results. Pact currently covers the SPA session, logout, quote and consent calls to the web Worker (`/auth/session`, `/auth/logout`, `POST /api/v1/me/quotes`, `/api/v1/consents` and its sub-paths); do not claim consumer contracts or use cases that do not exist. See [contracts](shared/contracts/README.md#consumer-contracts-pact).
