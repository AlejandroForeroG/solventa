import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));

export function buildApiDocs({ specsDirectory = resolve(root, 'packages/contracts/openapi'), outputDirectory = resolve(root, 'apps/web/dist/api/docs') } = {}) {
  mkdirSync(outputDirectory, { recursive: true });
  const catalog = [];
  for (const version of readdirSync(specsDirectory).sort()) {
    if (!/^v[1-9][0-9]*$/.test(version)) continue;
    for (const file of readdirSync(resolve(specsDirectory, version)).sort()) {
      if (!/^[a-z][a-z0-9-]*\.yaml$/.test(file)) continue;
      const source = resolve(specsDirectory, version, file);
      const spec = parse(readFileSync(source, 'utf8'));
      if (!Object.keys(spec.paths ?? {}).length) continue;
      const name = file.replace(/\.yaml$/, '.json');
      const destination = resolve(outputDirectory, version, name);
      mkdirSync(resolve(outputDirectory, version), { recursive: true });
      const result = spawnSync(process.execPath, [resolve(root, 'node_modules/@redocly/cli/bin/cli.js'), 'bundle', source, '--config', resolve(root, 'packages/contracts/redocly.yaml'), '--output', destination], { stdio: 'inherit', windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Could not bundle ${version}/${file}`, { cause: result.error });
      catalog.push({ name: `${spec.info.title} (${version})`, url: `/api/docs/${version}/${name}` });
    }
  }
  if (!catalog.length) throw new Error('No OpenAPI operations found for the documentation viewer.');
  writeFileSync(resolve(outputDirectory, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  copyFileSync(resolve(root, 'node_modules/@scalar/api-reference/dist/browser/standalone.js'), resolve(outputDirectory, 'scalar.js'));
  copyFileSync(resolve(root, 'packages/assets/brand/solventa-wordmark-dark.svg'), resolve(outputDirectory, 'wordmark.svg'));
  for (const file of ['index.html', 'viewer.js', 'viewer.css']) {
    copyFileSync(resolve(root, 'tools/api-docs', file), resolve(outputDirectory, file));
  }
  const fontsDirectory = resolve(root, 'packages/assets/fonts/ibm-plex');
  mkdirSync(resolve(outputDirectory, 'fonts'), { recursive: true });
  for (const file of readdirSync(fontsDirectory).filter(file => file.endsWith('.woff2') || file === 'LICENSE.txt')) {
    copyFileSync(resolve(fontsDirectory, file), resolve(outputDirectory, 'fonts', file));
  }
  return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildApiDocs();
