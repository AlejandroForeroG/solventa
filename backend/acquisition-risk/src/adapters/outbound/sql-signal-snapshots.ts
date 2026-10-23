import { Client } from 'pg';
import type { SignalSnapshots, SignalSnapshotWrite } from '../../application/ports/signal-sources';
import type { Signal, SignalScope } from '../../domain/signal';

type SnapshotRow = { consent_reference: string; expires_at: Date | string; signals: unknown };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function signalFrom(value: unknown, scope: SignalScope): Signal | null {
  if (!isRecord(value) || value.scope !== scope || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) || !isRecord(value.data)) return null;
  for (const field of Object.values(value.data)) if (!['string', 'number', 'boolean'].includes(typeof field)) return null;
  return { scope, capturedAt: value.capturedAt, data: value.data as Signal['data'] };
}

export class SqlSignalSnapshots implements SignalSnapshots {
  constructor(private readonly connectionString: string) {}

  private async connection<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 700, query_timeout: 700 });
    client.on('error', () => {});
    try { await client.connect(); return await action(client); } finally { await client.end().catch(() => {}); }
  }

  async find(subjectToken: string, scope: SignalScope, consentId: string) {
    return this.connection(async client => {
      const result = await client.query<SnapshotRow>(`SELECT consent_reference,expires_at,signals
        FROM acquisition.risk_profiles
        WHERE subject_token=$1 AND source=$2 AND purpose='risk_profiling' AND consent_reference=$3 AND expires_at>now()
        ORDER BY captured_at DESC LIMIT 1`, [subjectToken, scope, consentId]);
      const row = result.rows[0];
      const signal = row ? signalFrom(row.signals, scope) : null;
      if (!row || !signal) return null;
      const validUntil = row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString();
      return { consentId: row.consent_reference, validUntil, signal };
    });
  }

  async save(snapshot: SignalSnapshotWrite): Promise<void> {
    await this.connection(async client => {
      await client.query(`INSERT INTO acquisition.risk_profiles
        (id,version,subject_token,source,captured_at,expires_at,quality,purpose,consent_id,consent_reference,consent_version,signals,correlation_id)
        VALUES (gen_random_uuid(),1,$1,$2,$3,$4,'provider','risk_profiling',NULL,$5,$6,$7,$8)`,
      [snapshot.subjectToken, snapshot.signal.scope, snapshot.signal.capturedAt, snapshot.validUntil, snapshot.consentId,
        snapshot.consentVersion, JSON.stringify(snapshot.signal), snapshot.traceId]);
    });
  }
}
