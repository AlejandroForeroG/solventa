import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildApiDocs } from './build-api-docs.mjs';

test('building the viewer discovers new domains and resolves shared references from the current contract source', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'solventa-api-docs-'));
  const specsDirectory = resolve(directory, 'specs');
  const outputDirectory = resolve(directory, 'output');
  mkdirSync(resolve(specsDirectory, 'v2'), { recursive: true });
  const shared = resolve(specsDirectory, 'v2/common.yaml');
  writeFileSync(shared, 'openapi: 3.0.3\ninfo: {title: Shared, version: 2.0.0}\npaths: {}\ncomponents:\n  schemas:\n    Result: {type: object, properties: {state: {type: string, enum: [initial]}}}\n');
  writeFileSync(resolve(specsDirectory, 'v2/new-domain.yaml'), `openapi: 3.0.3
info: {title: New domain API, version: 2.0.0}
servers: [{url: /api/v2}]
paths:
  /new-domain:
    get:
      operationId: getNewDomain
      summary: Read the new domain
      security: []
      responses:
        '200':
          description: Result
          content:
            application/json:
              schema: {$ref: './common.yaml#/components/schemas/Result'}
        '400': {description: Invalid input}
`);
  const catalog = buildApiDocs({ specsDirectory, outputDirectory });
  const css = readFileSync(resolve(outputDirectory, 'viewer.css'), 'utf8');
  const fonts = [...css.matchAll(/url\('\/api\/docs\/fonts\/([^']+\.woff2)'\)/g)].map(match => match[1]);
  assert.equal(fonts.length, 6, 'all declared font faces must be bundled');
  for (const font of fonts) {
    const bytes = readFileSync(resolve(outputDirectory, 'fonts', font));
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
    assert.deepEqual(bytes, readFileSync(new URL(`../packages/assets/fonts/ibm-plex/${font}`, import.meta.url)));
  }
  assert.match(readFileSync(resolve(outputDirectory, 'fonts/LICENSE.txt'), 'utf8'), /SIL OPEN FONT LICENSE/);
  assert.deepEqual(catalog, [{ name: 'New domain API (v2)', url: '/api/docs/v2/new-domain.json' }]);
  const bundled = resolve(outputDirectory, 'v2/new-domain.json');
  assert.doesNotMatch(readFileSync(bundled, 'utf8'), /common\.yaml/);
  assert.deepEqual(JSON.parse(readFileSync(bundled, 'utf8')).components.schemas.Result.properties.state.enum, ['initial']);
  writeFileSync(shared, readFileSync(shared, 'utf8').replace('[initial]', '[updated]'));
  buildApiDocs({ specsDirectory, outputDirectory });
  assert.deepEqual(JSON.parse(readFileSync(bundled, 'utf8')).components.schemas.Result.properties.state.enum, ['updated']);
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, 'catalog.json'), 'utf8')), catalog);
});

test('an empty contract directory fails the build rather than publishing an empty viewer', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'solventa-api-docs-empty-'));
  assert.throws(() => buildApiDocs({ specsDirectory: directory, outputDirectory: resolve(directory, 'output') }), /No OpenAPI operations/);
});
