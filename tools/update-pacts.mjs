import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';

const pactsDirectory = 'packages/contracts/pacts';
const testsDirectory = 'tests/pact';

// Pact merges interactions into existing files, so stale ones are removed first.
for (const name of readdirSync(pactsDirectory).filter(file => file.endsWith('.json'))) rmSync(`${pactsDirectory}/${name}`);
const consumerTests = readdirSync(testsDirectory).filter(name => name.endsWith('.consumer.test.ts')).map(name => `${testsDirectory}/${name}`);
const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', ...consumerTests], { stdio: 'inherit', env: { ...process.env, PACT_UPDATE: 'true' }, windowsHide: true });
process.exit(result.status ?? 1);
