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

Coverage is an aid to find decisions no test executes, not a goal. Measure a file with Node's built-in coverage, for example `node --import tsx --test --experimental-test-coverage --test-coverage-include='<file>' <suites>`, and add `--test-reporter=lcov --test-reporter-destination=<path>` for an LCOV file. Branches that belong to the transpiler (esbuild helpers and default-parameter wrappers, reported with an undefined line) have no behavior of their own: do not write tests for them or exclude files to raise the figure. SQL and Worker runtime suites are not part of this measurement, so a low figure for an adapter they cover does not mean it is untested.

The focused coverage command measures mobile session UI/custody and the SQL-backed session, device, offer and financial flows. Start the local database with `npm run infra:up`, then run `npm run coverage:sol-104`. The command merges unit, native-boundary module tests and real SQL suites and writes text output plus HTML, JSON and LCOV artifacts under `coverage/sol-104/`. It fails on a failed suite, without imposing a numeric coverage threshold. The welcome-screen tests assert progress announcements, errors, available actions and disabled states independently, including the primary-authentication alternative to biometric unlock. This focused report complements rather than replaces the normal suites and does not claim native-device execution or whole-repository coverage.

The CI `validate` job runs the authentication, identity-verification, partner-access, quote, consent, financial and security SQL suites after starting its local database and checking fresh migrations. Each suite is mandatory: a missing script/file or failed assertion fails CI. Post-merge Deploy reuses these checks with local synthetic data and no remote administrative credentials. Schema and SQL/RPC checks run afterwards; shutdown also runs after failure. `test:identity-verification:sql` creates a generated database and uses the real owner adapter/TLS/least grants; unit/HTTP doubles cannot replace it.

In the PR, link changed documentation and describe protected behavior, commands and results. Pact covers SPA session/logout/quote/consent calls and native authentication/device/onboarding calls to the gateway. Native onboarding uses the actual mobile HTTP adapter and persisted synthetic response examples; provider states execute real gateway/Identity code with explicit WorkOS/SQL doubles. `test:runtime` additionally executes its JSON writes/evaluation/revocation and upload bounds across a real workerd Service Binding. These checks establish neither device behavior nor a deployed journey. See [contracts](shared/contracts/README.md#consumer-contracts-pact).
