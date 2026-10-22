import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const c8 = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url));
const coverageRoot = path.join(root, 'coverage');
const tempRoot = path.join(coverageRoot, '.tmp-sol-104');
const partsRoot = path.join(coverageRoot, '.parts-sol-104');
const report = path.join(coverageRoot, 'sol-104');
const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const includes = [
  'backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions.ts',
  'backend/identity-consent-ecosystem/src/adapters/outbound/registered-devices.ts',
  'apps/mobile/src/features/welcome/presentation/WelcomeScreen.tsx',
  'apps/mobile/src/features/authentication/presentation/AuthenticationProvider.tsx',
  'apps/mobile/src/features/authentication/adapters/secure-token-store.ts',
  'backend/acquisition-risk/src/adapters/outbound/sql-offer-store.ts',
  'backend/policy-claims-payments/src/application/policy-finance.ts',
  'backend/policy-claims-payments/src/adapters/outbound/sql-financial-store.ts',
];
const common = ['--all', ...includes.flatMap(file => ['--include', file])];
const unitTests = [
  'tests/authentication.test.ts',
  'tests/mobile-authentication.test.ts',
  'tests/mobile-authentication-http.test.ts',
  'tests/biometric-authentication.test.ts',
  'tests/registered-devices.test.ts',
  'tests/identity-security.test.ts',
  'tests/identity-security-http.test.ts',
  'tests/mobile-channel-authentication.test.ts',
  'tests/mobile-biometric-authentication.test.ts',
  'tests/mobile-localization.test.ts',
  'tests/financial-access.test.ts',
  'tests/financial-http.test.ts',
  'tests/financial-contract.test.ts',
  'tests/financial.test.ts',
  'tests/offers.test.ts',
  'tests/resource-access-denials.test.ts',
];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function capture(name, nodeArgs) {
  const temp = path.join(tempRoot, name);
  const part = path.join(partsRoot, name);
  run([c8, ...common, '--clean', '--reporter=json', `--temp-directory=${temp}`, `--report-dir=${part}`,
    process.execPath, ...nodeArgs]);
  return JSON.parse(await readFile(path.join(part, 'coverage-final.json'), 'utf8'));
}

await rm(tempRoot, { recursive: true, force: true });
await rm(partsRoot, { recursive: true, force: true });
await rm(report, { recursive: true, force: true });
await mkdir(report, { recursive: true });

const coverage = createCoverageMap({});
coverage.merge(await capture('unit', ['--import', 'tsx', '--test', ...unitTests]));
coverage.merge(await capture('mobile-presentation', ['--experimental-test-module-mocks', '--import', 'tsx', '--test',
  'tests/mobile-secure-token-store.test.mts',
  'tests/mobile-authentication-provider.test.mts',
  'tests/mobile-welcome-screen.test.mts']));
coverage.merge(await capture('authentication-sql', ['--import', 'tsx', 'infra/authentication-smoke.mts']));
coverage.merge(await capture('offers-sql', ['--import', 'tsx', 'infra/offers-smoke.mts']));
coverage.merge(await capture('financial-sql', ['--import', 'tsx', 'infra/financial-smoke.mts']));

const context = createContext({ dir: report, coverageMap: coverage });
for (const reporter of ['text', 'json', 'lcov', 'html']) reports.create(reporter).execute(context);
