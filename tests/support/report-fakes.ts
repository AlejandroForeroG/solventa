import { reviewDelivery } from '../../backend/policy-claims-payments/src/adapters/outbound/report-destination-contract';
import type { DeliveryRecord, DeliveryResult, DestinationAnswer, NewRevision, ReportActor, ReportDestination, ReportQuery, ReportStore, RevisionSummary, StoredRevision } from '../../backend/policy-claims-payments/src/application/ports/report';
import type { ReportDelivery, ReportDestinationId, ReportFacts } from '../../backend/policy-claims-payments/src/domain/report';

// Mirrors the SQL store's rules: same content is the same revision, a changed set adds the next one, a final delivery is never overwritten.
export class MemoryReportStore implements ReportStore {
  facts_: ReportFacts;
  revisions: (StoredRevision & { generatedBy: string })[] = [];
  audit: { action: string; outcome: string; actor: string }[] = [];
  private deliveries = new Map<string, DeliveryRecord & { reportId: string }>();
  private counter = 0;
  constructor(facts: ReportFacts) { this.facts_ = facts; }
  async facts() { return this.facts_; }
  async save(input: NewRevision, actor: ReportActor) {
    const same = this.revisions.find(row => row.period === input.period && row.destination === input.destination && row.contentHash === input.contentHash);
    if (same) { this.audit.push({ action: 'reports.generate', outcome: 'unchanged', actor: actor.clientId }); return { report: this.summary(same), created: false }; }
    const revision = this.revisions.filter(row => row.period === input.period && row.destination === input.destination).length + 1;
    const generatedAt = new Date(Date.UTC(2026, 10, 30, 12, 0, this.counter++)).toISOString();
    const manifest = input.manifestFor(revision, generatedAt);
    const stored = { id: `90000000-0000-4000-8000-${String(this.revisions.length + 1).padStart(12, '0')}`, period: input.period, destination: input.destination, revision,
      formatVersion: manifest.formatVersion, contentHash: input.contentHash, manifest, generatedAt, delivery: null, content: input.csv, generatedBy: actor.clientId };
    this.revisions.push(stored);
    this.audit.push({ action: 'reports.generate', outcome: 'created', actor: actor.clientId });
    return { report: this.summary(stored), created: true };
  }
  async list(query: ReportQuery, actor: ReportActor) {
    this.audit.push({ action: 'reports.list', outcome: 'success', actor: actor.clientId });
    const items = this.revisions.filter(row => (!query.period || row.period === query.period) && (!query.destination || row.destination === query.destination)).map(row => this.summary(row)).reverse();
    return { items, next: null };
  }
  async load(id: string, actor: ReportActor) {
    const row = this.revisions.find(candidate => candidate.id === id);
    this.audit.push({ action: 'reports.download', outcome: row ? 'success' : 'not_found', actor: actor.clientId });
    return row ? { ...this.summary(row), content: row.content } : null;
  }
  async openDelivery(id: string, actor: ReportActor) {
    const row = this.revisions.find(candidate => candidate.id === id);
    if (!row) { this.audit.push({ action: 'reports.send', outcome: 'not_found', actor: actor.clientId }); return null; }
    if (!this.deliveries.has(id)) this.deliveries.set(id, { id: `90000000-0000-4000-8000-d${String(this.deliveries.size + 1).padStart(11, '0')}`, reportId: id, status: 'pending', attempts: 0, reference: null, rejectionCode: null, updatedAt: row.generatedAt });
    this.audit.push({ action: 'reports.send', outcome: 'requested', actor: actor.clientId });
    return { report: { ...this.summary(row), content: row.content }, delivery: this.record(id) };
  }
  async markDispatched(deliveryId: string) {
    const delivery = [...this.deliveries.values()].find(candidate => candidate.id === deliveryId);
    if (!delivery || delivery.status === 'acknowledged' || delivery.status === 'rejected') return null;
    delivery.status = 'dispatched'; delivery.attempts += 1;
    return this.record(delivery.reportId);
  }
  async recordDelivery(deliveryId: string, result: DeliveryResult, actor: ReportActor) {
    const delivery = [...this.deliveries.values()].find(candidate => candidate.id === deliveryId) as DeliveryRecord & { reportId: string };
    if (delivery.status === 'acknowledged' || delivery.status === 'rejected') return this.record(delivery.reportId);
    delivery.status = result.status;
    delivery.reference = result.status === 'acknowledged' ? result.reference : null;
    delivery.rejectionCode = result.status === 'rejected' ? result.code : null;
    this.audit.push({ action: `reports.delivery.${result.status}`, outcome: result.status, actor: actor.clientId });
    return this.record(delivery.reportId);
  }
  private record(reportId: string): DeliveryRecord { const { reportId: _ignored, ...record } = this.deliveries.get(reportId) as DeliveryRecord & { reportId: string }; return record; }
  private summary(row: StoredRevision): RevisionSummary {
    const { content: _content, generatedBy: _generatedBy, ...summary } = row as StoredRevision & { generatedBy?: string };
    return { ...summary, delivery: this.deliveries.has(row.id) ? this.record(row.id) : null } as RevisionSummary;
  }
}

// A destination with its own ledger keyed by delivery identity, like the SQL mock; `silent` withholds the answer after recording it.
export class MemoryDestination implements ReportDestination {
  ledger = new Map<string, DestinationAnswer>();
  deliveries = 0;
  lookups = 0;
  silent = false;
  constructor(private readonly destination: ReportDestinationId) {}
  async deliver(message: ReportDelivery): Promise<DestinationAnswer> {
    this.deliveries += 1;
    if (!this.ledger.has(message.deliveryId)) {
      const verdict = reviewDelivery(this.destination, message);
      this.ledger.set(message.deliveryId, verdict.outcome === 'acknowledged' ? { outcome: 'acknowledged', reference: `MOCK-RPT-${message.deliveryId}` } : { outcome: 'rejected', code: verdict.code });
      if (this.silent) return new Promise<never>(() => {});
    }
    return this.ledger.get(message.deliveryId) as DestinationAnswer;
  }
  async lookup(deliveryId: string) { this.lookups += 1; return this.ledger.get(deliveryId) ?? null; }
}
