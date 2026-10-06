import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checkModule } from './architecture.mjs';
const root = resolve('backend/acquisition-risk');
const check = (file, source) => checkModule(resolve(root,file), source, root);
test('rejects infrastructure and another owner inside the core', () => {
  for (const source of ["import {Client} from 'pg'", "import type {X} from '../adapters/outbound/x'", "export {X} from '../../../identity-consent-ecosystem/src/domain/x'", "type X = import('cloudflare:workers').WorkerEntrypoint", "const x = import('hono')", 'fetch("https://example.com")']) assert.ok(check('src/application/run.ts',source).length);
});
test('domain cannot depend on application', () => assert.ok(check('src/domain/entity.ts', "import type {Port} from '../application/ports/port'").length));
test('relative ports, domain and adapter composition are accepted', () => {
  assert.deepEqual(check('src/application/run.ts', "import type {Port} from './ports/port'; import {Entity} from '../domain/entity'"), []);
  assert.deepEqual(check('src/adapters/outbound/sql.ts', "import {Client} from 'pg'; import type {Port} from '../../application/ports/port'"), []);
});
