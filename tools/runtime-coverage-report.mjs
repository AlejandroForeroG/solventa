import { readdir, readFile, mkdir, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { instrumentEntrypoint } from '../tests/support/runtime-coverage.mjs';

const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createSourceMapStore } = require('istanbul-lib-source-maps');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const root = path.resolve(import.meta.dirname, '..');
const directory = path.resolve(process.argv[2] ?? 'coverage/runtime');
const raw = createCoverageMap({});
for (const owner of ['acquisition-risk', 'identity-consent-ecosystem', 'policy-claims-payments']) {
  raw.addFileCoverage((await instrumentEntrypoint(path.join(root, 'backend', owner, 'src/index.ts'))).coverage);
}
const coverage = await createSourceMapStore().transformCoverage(raw);
for (const name of await readdir(directory)) {
  if (!name.endsWith('.json')) continue;
  coverage.merge(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
}
const normalized = createCoverageMap({});
const expected = ['acquisition-risk', 'identity-consent-ecosystem', 'policy-claims-payments'].map(owner => `backend/${owner}/src/index.ts`);
for (const file of coverage.files()) {
  const data = coverage.fileCoverageFor(file).toJSON();
  data.path = path.relative(root, file).replaceAll('\\', '/');
  if (!expected.includes(data.path)) throw new Error('Unexpected runtime coverage file: ' + data.path);
  normalized.addFileCoverage(data);
}
await mkdir(path.join(directory, 'report'), { recursive: true });
const context = createContext({ dir: path.join(directory, 'report'), coverageMap: normalized,
  sourceFinder: file => require('node:fs').readFileSync(path.join(root, file), 'utf8') });
for (const reporter of ['html', 'json', 'json-summary', 'lcovonly']) reports.create(reporter).execute(context);
await appendFile(path.join(directory, 'report/base.css'), await readFile(new URL('./coverage-report.css', import.meta.url), 'utf8'));
console.log(JSON.stringify(normalized.getCoverageSummary().toJSON()));
