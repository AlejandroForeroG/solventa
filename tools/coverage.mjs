import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const destination = path.resolve(process.argv[2] ?? path.join(root, 'coverage', new Date().toISOString().replaceAll(':', '-')));
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.mkdirSync(destination); // Refuse to overwrite a previous measurement.
const require = createRequire(root + '/package.json');
const ts = require('typescript');
const files = [], omittedTypeOnly = [];
function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = dir + '/' + entry.name;
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'worker-dist', '.wrangler', '.expo', 'assets'].includes(entry.name)) walk(file);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(file) || /\.d\.ts$|\.test\.|test-setup|vite\.config|vitest\.config|app\.config|expo-env/.test(file)) continue;
    if (!(file.includes('/src/') || file.includes('/worker/') || file === 'apps/mobile/App.tsx')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const parsed = ts.createSourceFile(file.replace(/\.tsx?$/, '.js'), output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const executable = parsed.statements.some(s => !(ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && s.exportClause.elements.length === 0));
    (executable ? files : omittedTypeOnly).push(file);
  }
}
for (const dir of ['apps', 'backend', 'packages']) walk(dir);
files.sort(); omittedTypeOnly.sort();
const nodeFiles = files.filter(file => !file.startsWith('apps/web/src/'));
const webFiles = files.filter(file => file.startsWith('apps/web/src/')).map(file => file.slice('apps/web/'.length));
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const inventory = { sourceRevision, root, measuredAt: new Date().toISOString(), files, omittedTypeOnly, nodeFiles, webFiles,
  sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) };
fs.writeFileSync(path.join(destination, 'inventory.json'), JSON.stringify(inventory, null, 2));
fs.writeFileSync(path.join(destination, 'c8.json'), JSON.stringify({ all: true, include: nodeFiles, exclude: [], extension: ['.ts', '.tsx', '.js'], reporter: ['json', 'json-summary', 'lcov', 'html', 'text-summary'], reportsDir: path.join(destination, 'node-report'), tempDirectory: path.join(destination, 'raw-node'), excludeAfterRemap: true }, null, 2));
let configImport = path.relative(destination, root + '/apps/web/vite.config.ts').replaceAll('\\', '/');
if (!configImport.startsWith('.')) configImport = './' + configImport;
fs.writeFileSync(path.join(destination, 'web.config.ts'), `import config from ${JSON.stringify(configImport)};\nexport default { ...config, root: ${JSON.stringify(root + '/apps/web')}, test: { ...config.test, coverage: { enabled: true, provider: 'v8', include: ${JSON.stringify(webFiles)}, exclude: [], reportsDirectory: ${JSON.stringify(path.join(destination, 'web-report'))}, reporter: ['json', 'json-summary', 'lcov', 'html', 'text-summary'] } } };\n`);
const tests = fs.readdirSync(root + '/tests').filter(file => file.endsWith('.test.ts')).map(file => 'tests/' + file);
tests.push(...fs.readdirSync(root + '/tests/pact').filter(file => file.endsWith('.test.ts')).map(file => 'tests/pact/' + file));
fs.writeFileSync(path.join(destination, 'run-node.mjs'), `import { spawnSync } from 'node:child_process';\nimport fs from 'node:fs';\nconst args = ['--import','tsx','--test','--test-concurrency=4',...${JSON.stringify(tests)}];\nconst startedAt = new Date().toISOString();\nconst result = spawnSync(process.execPath,args,{cwd:${JSON.stringify(root)},stdio:'inherit',env:{...process.env,CI:'true',SCARF_ANALYTICS:'false',WRANGLER_SEND_METRICS:'false'}});\nfs.writeFileSync(new URL('./node-run.json',import.meta.url),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),args,exitCode:result.status,error:result.error?.message},null,2));\nprocess.exitCode=result.status??1;\n`);
console.log(JSON.stringify({ sourceRevision, destination, executableFiles: files.length, node: nodeFiles.length, web: webFiles.length, omittedTypeOnly: omittedTypeOnly.length, testFiles: tests.length }));

const results = [];
function run(name, args, cwd = root, extraEnv = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: 'true', SCARF_ANALYTICS: 'false', WRANGLER_SEND_METRICS: 'false', ...extraEnv } });
  fs.writeFileSync(path.join(destination, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  results.push({ name, args, cwd, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message });
  fs.writeFileSync(path.join(destination, 'execution.json'), JSON.stringify({ sourceRevision, node: process.version, platform: process.platform, results }, null, 2));
  if (result.status !== 0) throw new Error(name + ' failed; inspect its retained log');
}
const c8 = path.join(root, 'node_modules/c8/bin/c8.js');
run('node', [c8, '--config', path.join(destination, 'c8.json'), process.execPath, path.join(destination, 'run-node.mjs')]);
const sqlRunner = path.join(destination, 'run-sql.mjs');
fs.writeFileSync(sqlRunner, `import {spawnSync} from 'node:child_process';\nfor(const file of ['security-alerts','offers','financial']){const result=spawnSync(process.execPath,['--import','tsx','infra/'+file+'-smoke.mts'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}\n`);
run('sql', [c8, '--config', path.join(destination, 'c8.json'), '--temp-directory', path.join(destination, 'raw-sql'), '--reports-dir', path.join(destination, 'sql-report'), process.execPath, sqlRunner]);
run('web', [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(destination, 'web.config.ts')], path.join(root, 'apps/web'));
run('runtime', ['--test', 'tests/access-runtime.test.mjs', 'tests/security-alert-runtime.test.mjs', 'tests/identity-verification-runtime.test.mjs', 'tests/financial-runtime.test.mjs'], root,
  { SOLVENTA_RUNTIME_COVERAGE: path.join(destination, 'runtime') });
run('runtime-report', ['tools/runtime-coverage-report.mjs', path.join(destination, 'runtime')]);
run('global-report', ['tools/coverage-report.mjs', destination]);
for (const file of files) {
  if (createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') !== inventory.sourceHashes[file]) throw new Error('Source changed during coverage: ' + file);
}
fs.writeFileSync(path.join(destination, 'source-integrity.json'), JSON.stringify({ sourceRevision, files: files.length, allMatch: true, checkedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ destination, passed: true, reports: ['unit-global', 'extended-global', 'runtime/report'] }));
