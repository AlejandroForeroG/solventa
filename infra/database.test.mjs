import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeState, validateRuntimeGrants, migrationChecksums, applyMigrations, owners } from './database.mjs';

test('partial DDL commit blocks replay even if ledger DML committed and rollback fails', async () => {
  let guard = false, ledgerCommitted = false, ddlCalls = 0;
  const failure = Object.assign(Error('partial commit'), {code: 'XXA00'});
  const db = {query: async (query, values) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.startsWith('SELECT version FROM')) return {rowCount: guard ? 1 : 0, rows: guard ? [{version: '0001_baseline.sql'}] : []};
    if (sql.includes('INSERT INTO') && sql.includes('schema_migration_failures')) guard = true;
    if (sql.includes('INSERT INTO') && sql.includes('schema_migrations ')) ledgerCommitted = true;
    if (sql.includes('DELETE FROM') && sql.includes('schema_migration_failures')) guard = false;
    if (typeof query === 'object') ddlCalls++;
    if (sql === 'COMMIT') throw failure;
    if (sql === 'ROLLBACK') throw Error('connection lost');
    return {rowCount: 0, rows: []};
  }};
  await assert.rejects(applyMigrations(db, owners[0]), error => error === failure && error.migration.endsWith('/0001_baseline.sql'));
  assert.ok(ledgerCommitted && guard);
  await assert.rejects(applyMigrations(db, owners[0]), {code: 'migration_reconciliation_required'});
  assert.equal(ddlCalls, 1);
});

test('migration checksums tolerate only LF/CRLF differences, including legacy ledgers', () => {
  const lf = migrationChecksums('SELECT 1;\nSELECT 2;\n');
  const crlf = migrationChecksums('SELECT 1;\r\nSELECT 2;\r\n');
  assert.equal(lf.canonical, crlf.canonical);
  assert.deepEqual(lf.accepted, crlf.accepted);
  assert.equal(lf.accepted.size, 2);
  assert.ok(!lf.accepted.has(migrationChecksums('SELECT 3;\nSELECT 2;\n').canonical));
});

test('runtime grants reject DDL, ledger writes and interpolated identifiers', () => {
  for (const grants of [{clients: ['ALL']}, {clients: ['CREATE']}, {clients: ['DELETE']}, {schema_migrations: ['INSERT']}, {schema_migration_failures: ['SELECT']}, {'clients; DROP DATABASE x': ['SELECT']}]) {
    assert.throws(() => validateRuntimeGrants(grants));
  }
  assert.deepEqual(validateRuntimeGrants({audit_events: ['SELECT', 'INSERT']}), {audit_events: ['SELECT', 'INSERT']});
});

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
