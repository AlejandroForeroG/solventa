import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const directory = 'packages/contracts/openapi';
const specs = readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.yaml')).map(name => `${directory}/${name}`);
if (!specs.length) {
  console.error('No OpenAPI specs found.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['node_modules/@redocly/cli/bin/cli.js', 'lint', '--config', 'packages/contracts/redocly.yaml', ...specs], { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
