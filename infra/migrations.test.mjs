import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { mkdtemp, readFile, access, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMigrationPlan, applyPendingMigrations } from './migrations.mjs';
import { migrationChecksums } from './database.mjs';
import { migrationConfiguration } from './migration-ci.mjs';

const catalog = ['acquisition', 'identity', 'policy'].map(schema => ({ owner: { schema }, grants: {}, migrations: [
  { version: '0001_baseline.sql', sql: 'SELECT 1;' }, { version: '0002_next.sql', sql: 'SELECT 2;' },
] }));
const ledger = () => [{ version: '0001_baseline.sql', checksum: migrationChecksums('SELECT 1;').canonical }];

function database(overrides = {}) {
  const mutations = [];
  const rows = Object.fromEntries(catalog.map(({ owner }) => [owner.schema, ledger()]));
  const guards = {};
  const db = { mutations, rows, guards, query: async (query, args = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    const schema = ['acquisition', 'identity', 'policy'].find(name => sql.includes(`${name}.`) || sql.includes(`"${name}".`));
    if (sql.includes('SELECT version, checksum')) return { rows: overrides.ledger?.(schema) ?? rows[schema] };
    if (sql.startsWith('SELECT checksum')) return { rows: rows[schema].filter(row => row.version === args[0]) };
    if (sql.includes('SELECT version FROM')) return { rows: overrides.guards?.(schema) ?? (guards[schema] ? [{ version: guards[schema] }] : []), rowCount: guards[schema] ? 1 : 0 };
    if (sql.includes('information_schema.tables')) return { rows: overrides.tables?.(args[0]) ?? [] };
    if (!['BEGIN READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql)) mutations.push(sql);
    if (sql.startsWith('INSERT INTO') && sql.includes('schema_migration_failures')) guards[schema] = args[0];
    if (sql.startsWith('INSERT INTO') && sql.includes('schema_migrations ')) rows[schema].push({ version: args[0], checksum: args[1] });
    if (sql.startsWith('DELETE FROM') && sql.includes('schema_migration_failures')) delete guards[schema];
    return { rows: [], rowCount: 0 };
  } };
  return db;
}

test('status lists applied and pending versions without mutations', async () => {
  const db = database();
  const result = await readMigrationPlan(db, catalog);
  assert.deepEqual(result.map(owner => [owner.applied, owner.pending]), catalog.map(() => [['0001_baseline.sql'], ['0002_next.sql']]));
  assert.deepEqual(db.mutations, []);
});

test('every owner is checked before applying any migration or grant', async () => {
  for (const [code, overrides] of [
    ['applied_migration_changed', { ledger: schema => schema === 'policy' ? [{ ...ledger()[0], checksum: '0'.repeat(64) }] : ledger() }],
    ['candidate_missing_migration', { ledger: schema => schema === 'policy' ? [...ledger(), { version: '0003_future.sql' }] : ledger() }],
    ['migration_reconciliation_required', { guards: schema => schema === 'policy' ? [{ version: '0002_next.sql' }] : [] }],
    ['migration_history_out_of_order', { ledger: schema => schema === 'policy' ? [{ version: '0002_next.sql', checksum: migrationChecksums('SELECT 2;').canonical }] : ledger() }],
    ['unexpected_schema_tables', { tables: schema => schema === 'policy' ? [{ table_name: 'unknown' }] : [] }],
  ]) {
    const db = database(overrides);
    await assert.rejects(applyPendingMigrations(db, 'staging', catalog), { code });
    assert.deepEqual(db.mutations, [], code);
  }
});

test('apply executes only pending SQL and a second run preserves recorded migrations', async () => {
  const db = database();
  const first = await applyPendingMigrations(db, 'staging', catalog);
  assert.ok(first.after.every(owner => owner.pending.length === 0 && owner.applied.length === 2));
  assert.equal(db.mutations.filter(sql => sql === 'SELECT 2;').length, 3);
  assert.ok(!db.mutations.includes('SELECT 1;'));
  const before = structuredClone(db.rows);
  await applyPendingMigrations(db, 'staging', catalog);
  assert.deepEqual(db.rows, before);
  assert.equal(db.mutations.filter(sql => sql === 'SELECT 2;').length, 3);
});

const secret = 'a'.repeat(64);
const variables = (environment = 'staging') => ({ GITHUB_REF_NAME: environment, DATABASE_HOST: 'database.example.com', DATABASE_PORT: '26257',
  DATABASE_CA_PEM: rootCertificates[0], MIGRATION_DATABASE_URL: `postgresql://operator:synthetic@database.example.com:26257/solventa_${environment}?sslmode=verify-full`,
  RUNTIME_STATE_JSON: JSON.stringify({ database: `solventa_${environment}`, passwords: { acquisition: secret, identity: secret, policy: secret } }) });

test('migration credentials reject crossed branches, databases, endpoints and TLS overrides', () => {
  for (const environment of ['dev', 'staging', 'prod']) assert.equal(migrationConfiguration(environment, variables(environment)).state.database, `solventa_${environment}`);
  for (const changed of [
    { GITHUB_REF_NAME: 'dev' }, { DATABASE_HOST: 'other.example.com' }, { RUNTIME_STATE_JSON: variables('dev').RUNTIME_STATE_JSON },
    { MIGRATION_DATABASE_URL: variables('dev').MIGRATION_DATABASE_URL },
    { MIGRATION_DATABASE_URL: variables().MIGRATION_DATABASE_URL.replace('verify-full', 'disable') },
    { MIGRATION_DATABASE_URL: variables().MIGRATION_DATABASE_URL + '&sslrootcert=/tmp/untrusted' },
    { MIGRATION_DATABASE_URL: '' },
  ]) assert.throws(() => migrationConfiguration('staging', { ...variables(), ...changed }));
});

test('an omitted or empty Environment port uses the existing CockroachDB default', () => {
  for (const port of [undefined, '']) {
    assert.equal(migrationConfiguration('staging', { ...variables(), DATABASE_PORT: port }).url.port, '26257');
  }
});

test('CI restores and removes only its own migration files without logging credentials', async () => {
  const script = fileURLToPath(new URL('./migration-ci.mjs', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'solventa-migrations-'));
  const env = { ...process.env, ...variables() };
  const run = action => spawnSync(process.execPath, [script, action, 'staging'], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
  try {
    await mkdir(join(directory, 'infra/.local'), { recursive: true });
    const retained = join(directory, '.env.infra.dev');
    await writeFile(retained, 'retained');
    const prepared = run('prepare');
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.ok(!prepared.stdout.includes('synthetic') && !prepared.stderr.includes(secret));
    assert.ok((await readFile(join(directory, '.env.infra.staging'), 'utf8')).includes('solventa_staging'));
    assert.equal(run('cleanup').status, 0);
    await assert.rejects(access(join(directory, '.env.infra.staging')), { code: 'ENOENT' });
    assert.equal(await readFile(retained, 'utf8'), 'retained');
    await writeFile(join(directory, '.env.infra.staging'), 'operator original');
    assert.notEqual(run('prepare').status, 0);
    assert.equal(run('cleanup').status, 0);
    assert.equal(await readFile(join(directory, '.env.infra.staging'), 'utf8'), 'operator original');
  } finally { await rm(directory, { recursive: true }); }
});
