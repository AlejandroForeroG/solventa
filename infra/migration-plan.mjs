import { runMigrations } from './migrations.mjs';

const environment = process.argv[2];
try {
  if (!['local', 'dev', 'staging', 'prod'].includes(environment) || process.argv.length !== 3) {
    throw Object.assign(Error('Specify environment'), { code: 'specify_environment' });
  }
  await runMigrations(environment);
} catch (error) {
  console.error(JSON.stringify({ environment, code: error.code ?? 'migration_plan_failed' }));
  process.exitCode = 1;
}
