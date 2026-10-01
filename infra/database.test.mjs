import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeState } from './database.mjs';

test('an existing shared environment requires its original credential state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solventa-state-'));
  const path = join(directory, 'runtime.dev.json');
  try {
    const admin = { query: async sql => { assert.equal(sql, 'SHOW USERS'); return { rows: [{ username: 'solventa_dev_acquisition' }] }; } };
    await assert.rejects(runtimeState('dev', { database: 'solventa_dev' }, admin, path), { code: 'runtime_state_missing' });
    await assert.rejects(access(path), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true }); }
});
test('fresh credentials are persisted and reused without querying or rotating users', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solventa-state-'));
  const path = join(directory, 'runtime.dev.json');
  try {
    const config = { database: 'solventa_dev' };
    const first = await runtimeState('dev', config, { query: async () => ({ rows: [] }) }, path);
    const repeated = await runtimeState('dev', config, { query: async () => { throw Error('Existing state must be reused'); } }, path);
    assert.deepEqual(repeated, first);
    assert.equal(Object.keys(first.passwords).length, 3);
  } finally { await rm(directory, { recursive: true }); }
});
