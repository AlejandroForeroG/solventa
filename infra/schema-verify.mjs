import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { owners, settings, clientFor, migrationChecksums, validateRuntimeGrants } from './database.mjs';

export async function verifySchema(environment, { administrative = false } = {}) {
  const config = await settings(environment);
  const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, 'utf8'));
  assert.equal(state.database, config.database);
  const results = [];
  for (const owner of owners) {
    const url = new URL(config.url);
    url.pathname = '/' + config.database;
    url.username = `solventa_${environment}_${owner.schema}`;
    url.password = state.passwords[owner.schema];
    const db = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
    try {
      await db.connect();
      await db.query('BEGIN TRANSACTION READ ONLY');
      const directory = `backend/${owner.name}/migrations`;
      const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
      const ledger = (await db.query(`SELECT version, checksum FROM ${owner.schema}.schema_migrations ORDER BY version`)).rows;
      assert.deepEqual(ledger.map(row => row.version), files, 'Schema migration versions differ');
      for (const row of ledger) {
        const sql = await readFile(`${directory}/${row.version}`, 'utf8');
        assert.ok(migrationChecksums(sql).accepted.has(row.checksum), 'Schema migration checksum differs');
      }
      const grants = validateRuntimeGrants(JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
      const expected = Object.keys(grants).concat('schema_migrations', 'schema_migration_failures').sort();
      const tables = (await db.query('SELECT table_name FROM information_schema.tables WHERE table_catalog=$1 AND table_schema=$2 ORDER BY table_name', [config.database, owner.schema])).rows.map(row => row.table_name);
      assert.deepEqual(tables, expected, 'Schema tables differ');
      for (const table of Object.keys(grants)) await db.query(`SELECT * FROM ${owner.schema}.${table} LIMIT 0`);
      results.push({ schema: owner.schema, tables: Object.keys(grants).length, versionsMatch: true, checksumsMatch: true, ownReads: true });
    } finally { await db.end(); }
  }
  // Runtime cannot inspect administrative migration guards or prove the absence
  // of objects hidden by catalog privileges. Operator verification is separate.
  if (administrative) {
    const url = new URL(config.url); url.pathname = '/' + config.database;
    const admin = clientFor(url, config.ssl);
    try {
      await admin.connect();
      await admin.query('BEGIN TRANSACTION READ ONLY');
      const publicTables = await admin.query("SELECT table_name FROM information_schema.tables WHERE table_catalog=$1 AND table_schema='public'", [config.database]);
      assert.equal(publicTables.rowCount, 0, 'Unexpected public tables');
      for (const owner of owners) {
        assert.equal(Number((await admin.query(`SELECT count(*) AS n FROM ${owner.schema}.schema_migration_failures`)).rows[0].n), 0, 'Incomplete migration requires reconciliation');
      }
    } finally { await admin.end(); }
  }
  const result = { environment, status: 'passed', results, administrativeChecks: administrative };
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] === resolve('infra/schema-verify.mjs')) {
  try { await verifySchema(process.argv[2], { administrative: process.argv[3] === '--admin' }); }
  catch (error) { console.error(JSON.stringify({ environment: process.argv[2], status: 'failed', code: error.code ?? 'schema_mismatch' })); process.exitCode = 1; }
}
