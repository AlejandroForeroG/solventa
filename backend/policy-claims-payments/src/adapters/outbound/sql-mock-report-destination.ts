import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { UUID } from '../../domain/financial';
import type { ReportDelivery, ReportDestinationId } from '../../domain/report';
import type { DestinationAnswer, ReportDestination } from '../../application/ports/report';
import { reviewDelivery } from './report-destination-contract';

export type ReportDestinationFault = 'none' | 'timeout';
type Receipt = { destination: ReportDestinationId; content_hash: string; outcome: 'acknowledged' | 'rejected'; reference: string | null; rejection_code: string | null };
const answerOf = (row: Receipt): DestinationAnswer => row.outcome === 'acknowledged' ? { outcome: 'acknowledged', reference: row.reference as string } : { outcome: 'rejected', code: row.rejection_code as string };

// An explicitly simulated destination: it validates the delivered content for real and records its answer in its own ledger
// keyed by the delivery identity, so a repeated delivery or a lookup after a timeout finds the original answer.
// With the `timeout` fault the receipt is recorded and the answer is withheld, which is the uncertain case a caller must reconcile.
export class SqlMockReportDestination implements ReportDestination {
  constructor(private readonly destination: ReportDestinationId, private readonly connectionString: string, private readonly fault: ReportDestinationFault = 'none') {}

  async deliver(message: ReportDelivery): Promise<DestinationAnswer> {
    if (!UUID.test(message.deliveryId)) throw new Error('mock_report_destination_invalid_identity');
    const verdict = reviewDelivery(this.destination, message);
    const contentHash = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const db = this.client();
    let first = false;
    let stored: Receipt;
    try {
      await db.connect();
      first = (await db.query(`INSERT INTO policy.report_destination_receipts (delivery_id, destination, content_hash, outcome, reference, rejection_code)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (delivery_id) DO NOTHING`, [message.deliveryId, this.destination, contentHash,
        verdict.outcome, verdict.outcome === 'acknowledged' ? `MOCK-RPT-${message.deliveryId}` : null, verdict.outcome === 'rejected' ? verdict.code : null])).rowCount === 1;
      stored = await this.receipt(db, message.deliveryId) as Receipt;
    } finally { await db.end().catch(() => {}); }
    // The same identity with different content is a conflict, never a second answer.
    if (stored.destination !== this.destination || stored.content_hash !== contentHash) throw new Error('mock_report_destination_conflict');
    if (this.fault === 'timeout' && first) await new Promise<never>(() => {});
    return answerOf(stored);
  }

  async lookup(deliveryId: string): Promise<DestinationAnswer | null> {
    const db = this.client();
    try {
      await db.connect();
      const stored = await this.receipt(db, deliveryId);
      if (stored && stored.destination !== this.destination) throw new Error('mock_report_destination_conflict');
      return stored ? answerOf(stored) : null;
    } finally { await db.end().catch(() => {}); }
  }

  private client() {
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1500, query_timeout: 1500 });
    db.on('error', () => {});
    return db;
  }
  private async receipt(db: Client, deliveryId: string): Promise<Receipt | undefined> {
    return (await db.query<Receipt>('SELECT destination, content_hash, outcome, reference, rejection_code FROM policy.report_destination_receipts WHERE delivery_id = $1', [deliveryId])).rows[0];
  }
}
