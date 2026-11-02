import { explainDecision, type AuditSummary, type HistoricalDecision } from '../domain/audit-decision';

export type AuditQuery = { reference?: string; product?: 'vida_hipotecario' | 'flight_delay'; outcome?: 'accepted' | 'declined' | 'preliminary'; from?: string; to?: string; before?: string };
export type AuditReader = { clientId: string; expiresAt: string; traceId: string };
export interface AuditDecisionStore {
  list(query: AuditQuery, reader: AuditReader): Promise<{ items: AuditSummary[]; next: string | null }>;
  get(id: string, reader: AuditReader): Promise<HistoricalDecision | null>;
}
export class AuditDecisions {
  constructor(private readonly store: AuditDecisionStore, private readonly clock: { now(): Date }) {}
  async list(query: AuditQuery, reader: AuditReader) {
    this.active(reader);
    const result = await this.store.list(query, reader);
    this.active(reader);
    return { next: result.next, items: result.items.map(({ decisionId, decidedAt, outcome, ruleVersion, contractVersion, correlationId, quoteId, product }) => ({ decisionId, decidedAt, outcome, ruleVersion, contractVersion, correlationId, quoteId, product })) };
  }
  async get(id: string, reader: AuditReader) {
    this.active(reader);
    const result = await this.store.get(id, reader);
    this.active(reader);
    return result ? explainDecision(result) : null;
  }
  private active(reader: AuditReader) {
    if (!(Date.parse(reader.expiresAt) > this.clock.now().getTime())) throw new Error('audit_authorization_expired');
  }
}
