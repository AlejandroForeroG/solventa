import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { createInstrumenter } = require('istanbul-lib-instrument');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createSourceMapStore } = require('istanbul-lib-source-maps');
const snapshotPath = '/__test_runtime_coverage__';

export async function instrumentEntrypoint(file) {
  const source = await readFile(file, 'utf8');
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true, inlineSources: true,
  } });
  const instrumenter = createInstrumenter({ esModules: true, produceSourceMap: true });
  const code = instrumenter.instrumentSync(output.outputText, file, JSON.parse(output.sourceMapText));
  return { code, coverage: instrumenter.lastFileCoverage() };
}

// This plugin is used only by local runtime tests. No instrumented bundle is deployed.
export function runtimeCoveragePlugins() {
  if (!process.env.SOLVENTA_RUNTIME_COVERAGE) return [];
  return [{ name: 'local-entrypoint-coverage', setup(builder) {
    builder.onLoad({ filter: /[\\/]backend[\\/][^\\/]+[\\/]src[\\/]index\.ts$/, namespace: 'file' }, async args => {
      const { code: measured } = await instrumentEntrypoint(args.path);
      const tree = ts.createSourceFile(args.path, measured, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const entry = tree.statements.find(node => ts.isClassDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
      const fetch = entry?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === 'fetch');
      if (!fetch?.body) throw new Error('Runtime entrypoint has no fetch method');
      // Insert the measurement-only control after instrumentation so snapshots do not count as application calls.
      const position = fetch.body.getStart(tree) + 1;
      const control = `if (new URL(request.url).pathname === ${JSON.stringify(snapshotPath)}) return Response.json(globalThis.__coverage__ ?? {});`;
      return { contents: measured.slice(0, position) + control + measured.slice(position), loader: 'js', resolveDir: path.dirname(args.path) };
    });
  } }];
}

export async function captureRuntimeCoverage(runtime, names) {
  const destination = process.env.SOLVENTA_RUNTIME_COVERAGE;
  if (!destination) return;
  await mkdir(destination, { recursive: true });
  for (const name of names) {
    const worker = await runtime.getWorker(name);
    const response = await worker.fetch('http://coverage.local' + snapshotPath);
    if (response.status !== 200) throw new Error('Runtime coverage snapshot failed');
    const raw = await response.json();
    if (Object.keys(raw).length === 0) throw new Error('Runtime coverage snapshot is empty');
    const mapped = await createSourceMapStore().transformCoverage(createCoverageMap(raw));
    await writeFile(path.join(destination, name + '-' + randomUUID() + '.json'), JSON.stringify(mapped.toJSON()));
  }
}
