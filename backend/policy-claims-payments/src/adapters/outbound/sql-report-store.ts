import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { isClaimState } from '../../domain/claims';
import { POLICY_EVENT_TYPES, ReportError, type PaymentOperation, type PaymentState, type PolicyEventType, type ReportDestinationId, type ReportFacts, type ReportFormatVersion, type ReportManifest } from '../../domain/report';
import type { DeliveryRecord, DeliveryResult, DeliveryStatus, NewRevision, ReportActor, ReportQuery, ReportStore, RevisionSummary, StoredRevision } from '../../application/ports/report';

const PAGE_SIZE = 20;
const ATTEMPTS = 3;
type DeliveryColumns = { delivery_id: string | null; delivery_status: DeliveryStatus | null; delivery_attempts: number | null; delivery_reference: string | null;
  delivery_rejection_code: string | null; delivery_updated_at: Date | null };
type RevisionRow = DeliveryColumns & { id: string; period: string; destination: ReportDestinationId; revision: number; format_version: ReportFormatVersion; content?: string;
  content_hash: string; manifest: ReportManifest; generated_at: Date };
type DeliveryRow = { id: string; status: DeliveryStatus; attempts: number; reference: string | null; rejection_code: string | null; updated_at: Date };

const REVISION_COLUMNS = `r.id, r.period, r.destination, r.revision, r.format_version, r.content_hash, r.manifest, r.generated_at,
  d.id AS delivery_id, d.status AS delivery_status, d.attempts AS delivery_attempts, d.reference AS delivery_reference,
  d.rejection_code AS delivery_rejection_code, d.updated_at AS delivery_updated_at`;
const REVISION_SOURCE = 'policy.report_revisions r LEFT JOIN policy.report_deliveries d ON d.report_id = r.id';

const deliveryOf = (row: DeliveryRow): DeliveryRecord => ({ id: row.id, status: row.status, attempts: row.attempts, reference: row.reference,
  rejectionCode: row.rejection_code, updatedAt: row.updated_at.toISOString() });
const summaryOf = (row: RevisionRow): RevisionSummary => ({ id: row.id, period: row.period, destination: row.destination, revision: row.revision, formatVersion: row.format_version,
  contentHash: row.content_hash, manifest: row.manifest, generatedAt: row.generated_at.toISOString(),
  delivery: row.delivery_id === null ? null : deliveryOf({ id: row.delivery_id, status: row.delivery_status as DeliveryStatus, attempts: row.delivery_attempts as number,
    reference: row.delivery_reference, rejection_code: row.delivery_rejection_code, updated_at: row.delivery_updated_at as Date }) });

async function inTransaction<T>(connectionString: string, work: (db: Client) => Promise<T>, options: { readOnly?: boolean; retries?: number } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const db = new Client({ connectionString, connectionTimeoutMillis: 1500, query_timeout: 3000, statement_timeout: 3000 });
    db.on('error', () => {});
    try {
      await db.connect();
      await db.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      // A competing generation of the same period surfaces as a serialization failure or a uniqueness conflict; the retry reads the winner.
      const code = (error as { code?: string }).code;
      if (attempt >= (options.retries ?? 1) || (code !== '40001' && code !== '23505')) throw error;
    } finally { await db.end().catch(() => {}); }
  }
}

// `guardLease` makes the insert fail, and the whole transaction roll back, once the operator's authorization lease has run out.
async function audit(db: Client, actor: ReportActor, action: string, resourceType: string, resourceId: string, outcome: string, guardLease: boolean) {
  const result = await db.query(`INSERT INTO policy.audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
    SELECT $1, $2, $3, $4::UUID, $5, $6, now() + INTERVAL '90 days' WHERE $7::TIMESTAMPTZ IS NULL OR clock_timestamp() < $7::TIMESTAMPTZ RETURNING id`,
  [actor.clientId, action, resourceType, resourceId, outcome, actor.traceId, guardLease ? actor.expiresAt : null]);
  if (result.rowCount !== 1) throw new Error('report_authorization_expired');
}

async function revision(db: Client, id: string): Promise<RevisionRow | undefined> {
  return (await db.query<RevisionRow>(`SELECT ${REVISION_COLUMNS}, r.content FROM ${REVISION_SOURCE} WHERE r.id = $1`, [id])).rows[0];
}
async function deliveryById(db: Client, id: string): Promise<DeliveryRecord> {
  const row = (await db.query<DeliveryRow>('SELECT id, status, attempts, reference, rejection_code, updated_at FROM policy.report_deliveries WHERE id = $1', [id])).rows[0];
  if (!row) throw new Error('report_delivery_missing');
  return deliveryOf(row);
}

// Policies, lifecycle changes, claims and payments each come from their own persisted rows; the totals are summed again in SQL for the reconciliation.
const POLICY_COLUMNS = `p.id AS policy_id, p.coverage_snapshot->>'kind' AS coverage_kind,
  COALESCE(p.coverage_snapshot->>'sumInsured', p.coverage_snapshot->>'payoutAmount') AS coverage_amount,
  p.effective_from, p.effective_until, p.premium::DECIMAL(19,4)::STRING AS premium, p.currency`;

export class SqlReportStore implements ReportStore {
  constructor(private readonly connectionString: string) {}

  async facts(range: { start: string; end: string }): Promise<ReportFacts> {
    return inTransaction(this.connectionString, async db => {
      const bounds = [range.start, range.end];
      const issued = await db.query(`SELECT ${POLICY_COLUMNS}, 'policy_issued' AS type, s.signed_at AS event_at FROM policy.policy_signatures s JOIN policy.policies p ON p.id = s.policy_id
        WHERE p.status = 'issued' AND s.signed_at >= $1 AND s.signed_at < $2`, bounds);
      const lifecycle = await db.query(`SELECT ${POLICY_COLUMNS}, 'policy_' || (c.payload->>'action') AS type, c.occurred_at AS event_at FROM policy.policy_lifecycle_changes c
        JOIN policy.policies p ON p.id = c.policy_id WHERE c.occurred_at >= $1 AND c.occurred_at < $2`, bounds);
      const claims = await db.query(`SELECT id, claim_number, policy_id, status, COALESCE(submitted_at, created_at) AS event_at, estimated_amount::DECIMAL(19,4)::STRING AS estimated_amount, currency
        FROM policy.claims WHERE status <> 'draft' AND COALESCE(submitted_at, created_at) >= $1 AND COALESCE(submitted_at, created_at) < $2`, bounds);
      const payments = await db.query(`SELECT id, policy_id, operation, status, updated_at AS event_at, amount::DECIMAL(19,4)::STRING AS amount, currency, provider_reference
        FROM policy.payments WHERE status IN ('confirmed', 'refunded') AND updated_at >= $1 AND updated_at < $2`, bounds);
      const totals = await db.query<{ grp: string; currency: string; n: string; total: string }>(`
        SELECT 'policy_issued' AS grp, p.currency, count(*) AS n, COALESCE(sum(p.premium), 0)::DECIMAL(19,4)::STRING AS total
          FROM policy.policy_signatures s JOIN policy.policies p ON p.id = s.policy_id WHERE p.status = 'issued' AND s.signed_at >= $1 AND s.signed_at < $2 GROUP BY p.currency
        UNION ALL SELECT 'policy_' || (c.payload->>'action'), p.currency, count(*), COALESCE(sum(p.premium), 0)::DECIMAL(19,4)::STRING
          FROM policy.policy_lifecycle_changes c JOIN policy.policies p ON p.id = c.policy_id WHERE c.occurred_at >= $1 AND c.occurred_at < $2 GROUP BY c.payload->>'action', p.currency
        UNION ALL SELECT 'claim:' || status, currency, count(*), COALESCE(sum(estimated_amount), 0)::DECIMAL(19,4)::STRING
          FROM policy.claims WHERE status <> 'draft' AND COALESCE(submitted_at, created_at) >= $1 AND COALESCE(submitted_at, created_at) < $2 GROUP BY status, currency
        UNION ALL SELECT 'payment:' || operation || ':' || status, currency, count(*), COALESCE(sum(amount), 0)::DECIMAL(19,4)::STRING
          FROM policy.payments WHERE status IN ('confirmed', 'refunded') AND updated_at >= $1 AND updated_at < $2 GROUP BY operation, status, currency`, bounds);
      const policyRows = [...issued.rows, ...lifecycle.rows].map(row => {
        if (!(POLICY_EVENT_TYPES as readonly string[]).includes(row.type) || typeof row.coverage_kind !== 'string' || typeof row.coverage_amount !== 'string') throw new ReportError('invalid_fact');
        return { type: row.type as PolicyEventType, policyId: row.policy_id as string, coverageKind: row.coverage_kind, eventAt: (row.event_at as Date).toISOString(),
          effectiveFrom: (row.effective_from as Date).toISOString(), effectiveUntil: (row.effective_until as Date).toISOString(), premium: row.premium as string,
          coverageAmount: row.coverage_amount, currency: row.currency as string };
      });
      return { policies: policyRows,
        claims: claims.rows.map(row => {
          // An unknown state is reported as an error instead of being hidden or guessed, as in the claims inbox.
          if (!isClaimState(row.status)) throw new ReportError('invalid_fact');
          return { claimId: row.id as string, claimNumber: row.claim_number as string | null, policyId: row.policy_id as string, state: row.status, eventAt: (row.event_at as Date).toISOString(),
            estimatedAmount: row.estimated_amount as string | null, currency: row.currency as string };
        }),
        payments: payments.rows.map(row => ({ paymentId: row.id as string, policyId: row.policy_id as string, operation: row.operation as PaymentOperation, state: row.status as PaymentState,
          eventAt: (row.event_at as Date).toISOString(), amount: row.amount as string, currency: row.currency as string, reference: row.provider_reference as string | null })),
        aggregates: totals.rows.map(row => ({ group: row.grp, currency: row.currency, count: Number(row.n), amount: row.total })) };
    }, { readOnly: true });
  }

  async save(input: NewRevision, actor: ReportActor) {
    return inTransaction(this.connectionString, async db => {
      const existing = (await db.query<{ id: string; revision: number; content_hash: string }>(
        'SELECT id, revision, content_hash FROM policy.report_revisions WHERE period = $1 AND destination = $2 ORDER BY revision DESC', [input.period, input.destination])).rows;
      // The same content is the same revision: generating twice never adds a copy, and an earlier revision is never overwritten.
      const same = existing.find(row => row.content_hash === input.contentHash);
      const id = same?.id ?? randomUUID();
      if (!same) {
        const next = (existing[0]?.revision ?? 0) + 1;
        const generatedAt = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
        const manifest = input.manifestFor(next, generatedAt);
        await db.query(`INSERT INTO policy.report_revisions (id, period, destination, revision, format_version, content, content_hash, manifest, generated_at, generated_by, correlation_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10, $11)`,
        [id, input.period, input.destination, next, manifest.formatVersion, input.csv, input.contentHash, JSON.stringify(manifest), generatedAt, actor.clientId, actor.traceId]);
      }
      await audit(db, actor, 'reports.generate', 'report_revision', id, same ? 'unchanged' : 'created', true);
      return { report: summaryOf(await revision(db, id) as RevisionRow), created: !same };
    }, { retries: ATTEMPTS });
  }

  async list(query: ReportQuery, actor: ReportActor) {
    return inTransaction(this.connectionString, async db => {
      const values: unknown[] = [];
      const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
      const conditions: string[] = [];
      if (query.period) conditions.push(`r.period = ${parameter(query.period)}`);
      if (query.destination) conditions.push(`r.destination = ${parameter(query.destination)}`);
      if (query.before) conditions.push(`(r.generated_at, r.id) < (SELECT generated_at, id FROM policy.report_revisions WHERE id = ${parameter(query.before)}::UUID)`);
      const rows = (await db.query<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM ${REVISION_SOURCE} ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY r.generated_at DESC, r.id DESC LIMIT ${PAGE_SIZE + 1}`, values)).rows;
      await audit(db, actor, 'reports.list', 'report_collection', actor.clientId, 'success', true);
      return { items: rows.slice(0, PAGE_SIZE).map(summaryOf), next: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1].id : null };
    });
  }

  async load(id: string, actor: ReportActor): Promise<StoredRevision | null> {
    return inTransaction(this.connectionString, async db => {
      const row = await revision(db, id);
      await audit(db, actor, 'reports.download', 'report_revision', id, row ? 'success' : 'not_found', true);
      return row ? { ...summaryOf(row), content: row.content as string } : null;
    });
  }

  async openDelivery(id: string, actor: ReportActor) {
    return inTransaction(this.connectionString, async db => {
      const row = await revision(db, id);
      if (!row) { await audit(db, actor, 'reports.send', 'report_revision', id, 'not_found', true); return null; }
      await db.query(`INSERT INTO policy.report_deliveries (id, report_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (report_id) DO NOTHING`, [randomUUID(), id]);
      await audit(db, actor, 'reports.send', 'report_revision', id, 'requested', true);
      const stored = await revision(db, id) as RevisionRow;
      const summary = summaryOf(stored);
      return { report: { ...summary, content: stored.content as string }, delivery: summary.delivery as DeliveryRecord };
    });
  }

  async markDispatched(deliveryId: string, actor: ReportActor) {
    return inTransaction(this.connectionString, async db => {
      const row = (await db.query<DeliveryRow>(`UPDATE policy.report_deliveries SET status = 'dispatched', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'dispatched', 'uncertain') RETURNING id, status, attempts, reference, rejection_code, updated_at`, [deliveryId])).rows[0];
      if (!row) return null;
      await audit(db, actor, 'reports.delivery.dispatched', 'report_delivery', deliveryId, 'dispatched', false);
      return deliveryOf(row);
    });
  }

  async recordDelivery(deliveryId: string, result: DeliveryResult, actor: ReportActor) {
    return inTransaction(this.connectionString, async db => {
      const row = (await db.query<DeliveryRow>(`UPDATE policy.report_deliveries SET status = $2, reference = $3, rejection_code = $4, updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'dispatched', 'uncertain') RETURNING id, status, attempts, reference, rejection_code, updated_at`,
      [deliveryId, result.status, result.status === 'acknowledged' ? result.reference : null, result.status === 'rejected' ? result.code : null])).rows[0];
      // A concurrent attempt already reached a final state: keep it and report it, never overwrite an outcome.
      if (!row) return deliveryById(db, deliveryId);
      await audit(db, actor, `reports.delivery.${result.status}`, 'report_delivery', deliveryId, result.status, false);
      return deliveryOf(row);
    });
  }
}
