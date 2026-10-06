import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';

export function checkModule(file, source, backendRoot) {
  const errors = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const scope = relative(backendRoot, file).replaceAll(sep, '/');
  const core = scope.startsWith('src/domain/') || scope.startsWith('src/application/');
  const domain = scope.startsWith('src/domain/');
  function dependency(specifier) {
    if (!specifier.startsWith('.')) {
      if (core) errors.push(`${scope}: core cannot import ${specifier}`);
      return;
    }
    const target = relative(backendRoot, resolve(dirname(file), specifier)).replaceAll(sep, '/');
    if (target.startsWith('../')) errors.push(`${scope}: dependency leaves its backend`);
    if (domain && !target.startsWith('src/domain/')) errors.push(`${scope}: domain dependency points outside domain`);
    else if (core && !target.startsWith('src/domain/') && !target.startsWith('src/application/')) errors.push(`${scope}: application dependency points outside core`);
  }
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) dependency(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dependency(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const value = node.arguments[0];
      if (value && ts.isStringLiteral(value)) dependency(value.text);
      else errors.push(`${scope}: dependency must use a literal path`);
    }
    if (core && ts.isIdentifier(node) && ['Env','Cloudflare','process','fetch','Request','Response','ExecutionContext','console'].includes(node.text)) errors.push(`${scope}: platform identifier ${node.text} in core`);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  return errors;
}
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (path.endsWith('.ts')) result.push(path);
  }
  return result;
}
export async function checkArchitecture() {
  const errors = [];
  for (const owner of await readdir('backend', { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const backend = resolve('backend', owner.name);
    for (const file of await files(resolve(backend, 'src'))) errors.push(...checkModule(file, await readFile(file, 'utf8'), backend));
    const config = ts.readConfigFile(resolve(backend, 'tsconfig.core.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, backend);
    if (parsed.fileNames.length) {
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      for (const diagnostic of ts.getPreEmitDiagnostics(program)) errors.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    }
  }
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Architecture boundaries passed; empty cores are not implemented business flows.');
}
if (process.argv[1] === resolve('tools/architecture.mjs')) {
  try { await checkArchitecture(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
