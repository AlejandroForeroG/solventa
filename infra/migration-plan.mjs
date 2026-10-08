import { readFile, readdir } from 'node:fs/promises';
import { clientFor, migrationChecksums, owners, settings } from './database.mjs';

const environment = process.argv[2];
if (!['local', 'dev', 'staging', 'prod'].includes(environment) || process.argv.length !== 3) {
  console.error(JSON.stringify({ code: 'specify_environment' }));
  process.exit(1);
}

let db;
try {
  const configuration = await settings(environment);
  const target = new URL(configuration.url);
  target.pathname = '/' + configuration.database;
  db = clientFor(target, configuration.ssl);
  await db.connect();
  await db.query('BEGIN READ ONLY');
  const plans = [];
  for (const owner of owners) {
    const applied = (await db.query(`SELECT version, checksum FROM ${owner.schema}.schema_migrations ORDER BY version`)).rows;
    const guards = (await db.query(`SELECT version FROM ${owner.schema}.schema_migration_failures`)).rows;
    if (guards.length) throw Object.assign(Error('Migration reconciliation required'), { code: 'migration_reconciliation_required' });
    const files = (await readdir(`backend/${owner.name}/migrations`)).filter(file => file.endsWith('.sql')).sort();
    if (applied.some(row => !files.includes(row.version))) {
      throw Object.assign(Error('Candidate is missing an applied migration'), { code: 'candidate_missing_migration' });
    }
    const byVersion = new Map(applied.map(row => [row.version, row.checksum]));
    const pending = [];
    for (const version of files) {
      const checksums = migrationChecksums(await readFile(`backend/${owner.name}/migrations/${version}`, 'utf8'));
      if (byVersion.has(version)) {
        if (!checksums.accepted.has(byVersion.get(version))) {
          throw Object.assign(Error('An applied migration was changed'), { code: 'applied_migration_changed' });
        }
      } else pending.push(version);
    }
    plans.push({ owner: owner.schema, applied: applied.length, pending, guard: 'clear' });
  }
  await db.query('COMMIT');
  console.log(JSON.stringify({ environment, database: configuration.database, owners: plans }));
} catch (error) {
  if (db) await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ environment, code: error.code ?? 'migration_plan_failed' }));
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
}
