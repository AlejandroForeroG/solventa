import { Client } from 'pg';

// Operational adapter only; no infrastructure types enter the application core.
export async function databaseProbe(connectionString: string): Promise<{ ready: boolean; code: string }> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const result = await client.query('SELECT version FROM policy.schema_migrations WHERE version = $1', ['0001_baseline.sql']);
    return { ready: result.rows.length === 1, code: result.rows.length === 1 ? 'ok' : 'missing_migration' };
  } catch (error) {
    console.error(JSON.stringify({ event: 'database_probe_failed', code: (error as { code?: string }).code ?? 'connection_failed' }));
    return { ready: false, code: (error as { code?: string }).code ?? 'connection_failed' };
  } finally {
    await client.end().catch(() => {});
  }
}
