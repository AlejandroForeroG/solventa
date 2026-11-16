import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { owners, settings, clientFor, migrationChecksums, validateRuntimeGrants, applyMigrations, applyRuntimeGrants, verifyIsolation } from './database.mjs';
import { verifySchema } from './schema-verify.mjs';

const failure = code => Object.assign(Error(code), { code });

export async function migrationCatalog() {
  return Promise.all(owners.map(async owner => {
    const directory = `backend/${owner.name}/migrations`;
    const versions = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    return { owner, migrations: await Promise.all(versions.map(async version => ({ version, sql: await readFile(`${directory}/${version}`, 'utf8') }))),
      grants: validateRuntimeGrants(JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8'))) };
  }));
}

export async function readMigrationPlan(db, catalog) {
  const plans = [];
  await db.query('BEGIN READ ONLY');
  try {
    if ((await db.query("SELECT table_name FROM information_schema.tables WHERE table_catalog=current_database() AND table_schema='public'")).rows.length) {
      throw failure('unexpected_public_tables');
    }
    for (const { owner, migrations, grants } of catalog) {
      const applied = (await db.query(`SELECT version, checksum FROM ${owner.schema}.schema_migrations ORDER BY version`)).rows;
      if ((await db.query(`SELECT version FROM ${owner.schema}.schema_migration_failures`)).rows.length) throw failure('migration_reconciliation_required');
      const files = new Map(migrations.map(migration => [migration.version, migration]));
      const recorded = new Map(applied.map(row => [row.version, row.checksum]));
      if (applied.some(row => !files.has(row.version))) throw failure('candidate_missing_migration');
      const pending = [];
      for (const { version, sql } of migrations) {
        if (recorded.has(version)) {
          if (pending.length) throw failure('migration_history_out_of_order');
          if (!migrationChecksums(sql).accepted.has(recorded.get(version))) throw failure('applied_migration_changed');
        } else pending.push(version);
      }
      const expected = new Set([...Object.keys(grants), 'schema_migrations', 'schema_migration_failures']);
      const tables = (await db.query('SELECT table_name FROM information_schema.tables WHERE table_catalog=current_database() AND table_schema=$1', [owner.schema])).rows;
      if (tables.some(row => !expected.has(row.table_name))) throw failure('unexpected_schema_tables');
      plans.push({ owner: owner.schema, applied: applied.map(row => row.version), pending, guard: 'clear' });
    }
    await db.query('COMMIT');
    return plans;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function applyPendingMigrations(db, environment, catalog, report = () => {}) {
  // Validate every owner's ledger before the first DDL or permission change.
  const before = await readMigrationPlan(db, catalog);
  report({ environment, phase: 'before', owners: before });
  for (const { owner, migrations, grants } of catalog) {
    await applyMigrations(db, owner, migrations);
    await applyRuntimeGrants(db, owner, `solventa_${environment}_${owner.schema}`, grants);
  }
  const after = await readMigrationPlan(db, catalog);
  if (after.some(owner => owner.pending.length)) throw failure('migration_incomplete');
  report({ environment, phase: 'after', owners: after });
  return { before, after };
}

export async function runMigrations(environment, { apply = false, report = result => console.log(JSON.stringify(result)) } = {}) {
  const config = await settings(environment);
  const url = new URL(config.url);
  url.pathname = '/' + config.database;
  const db = clientFor(url, config.ssl);
  let result;
  try {
    const catalog = await migrationCatalog();
    await db.connect();
    if (apply) result = await applyPendingMigrations(db, environment, catalog, report);
    else result = { environment, database: config.database, owners: await readMigrationPlan(db, catalog) };
  } finally { await db.end().catch(() => {}); }
  if (apply) {
    await verifySchema(environment, { administrative: true });
    await verifyIsolation(environment);
    report({ environment, status: 'migrated_and_verified', applied: result.before.flatMap(owner => owner.pending.map(version => `${owner.owner}/${version}`)) });
  } else report(result);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, environment, ...extra] = process.argv.slice(2);
  try {
    if (!['status', 'apply'].includes(action) || !['local', 'dev', 'staging', 'prod'].includes(environment) || extra.length) throw failure('specify_migration_action_and_environment');
    await runMigrations(environment, { apply: action === 'apply' });
  } catch (error) {
    console.error(JSON.stringify({ environment, status: 'failed', code: error.code ?? 'migration_failed', migration: error.migration }));
    process.exitCode = 1;
  }
}
