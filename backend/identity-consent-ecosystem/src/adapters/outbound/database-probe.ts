import { Client } from 'pg';
import { safeCode } from '../safe-code';

// Operational adapter only; no infrastructure types enter the application core.
export async function databaseProbe(connectionString: string): Promise<{ ready: boolean; code: string; databaseName?: string }> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const result = await client.query('SELECT version, current_database() AS database FROM identity.schema_migrations WHERE version = $1', ['0001_baseline.sql']);
    return { ready: result.rows.length === 1, code: result.rows.length === 1 ? 'ok' : 'missing_migration', databaseName: result.rows[0]?.database };
  } catch (error) {
    const code = safeCode(error, 'connection_failed');
    console.error(JSON.stringify({ event: 'database_probe_failed', code }));
    return { ready: false, code };
  } finally {
    await client.end().catch(() => {});
  }
}
