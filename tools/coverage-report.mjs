import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(root + '/package.json');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const directory = path.resolve(process.argv[2]);
const inventory = JSON.parse(fs.readFileSync(path.join(directory, 'inventory.json'), 'utf8'));
const input = name => {
  const coverage = JSON.parse(fs.readFileSync(path.join(directory, name, 'coverage-final.json'), 'utf8'));
  const map = createCoverageMap({});
  for (const [absolute, data] of Object.entries(coverage)) {
    const file = path.relative(root, absolute).replaceAll('\\', '/');
    if (!inventory.files.includes(file)) throw Error('Unexpected file: ' + file);
    data.path = file; map.addFileCoverage(data);
  }
  return map;
};
const unit = input('node-report'), web = input('web-report'), sql = input('sql-report');
const totals = {};
for (const [name, components] of [['unit-global', [unit, web]], ['extended-global', [unit, sql, web]]]) {
  const map = createCoverageMap({});
  for (const component of components) map.merge(component);
  const missing = inventory.files.filter(file => !map.files().includes(file));
  if (missing.length) throw Error('Missing files: ' + missing.join(','));
  const report = path.join(directory, name);
  const context = createContext({ dir: report, coverageMap: map, sourceFinder: file => fs.readFileSync(path.join(root, file), 'utf8') });
  for (const format of ['html', 'json', 'json-summary', 'lcovonly']) reports.create(format).execute(context);
  totals[name] = map.getCoverageSummary().toJSON();
}
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ revision: inventory.sourceRevision, files: inventory.files.length, totals, runtime: 'Istanbul workerd entrypoints reported separately; never mixed with V8 totals' }, null, 2));
console.log(JSON.stringify(totals));
