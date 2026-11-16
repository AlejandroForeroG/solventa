import { HIGH_PRIORITY_DAYS, MEDIUM_PRIORITY_DAYS, OVERDUE_DAYS, summarize, type ClaimSummary } from '../domain/claims';
import type { ClaimInboxStore, ClaimQuery, ClaimReader } from './ports/claims';

export class ClaimInbox {
  constructor(private readonly store: ClaimInboxStore, private readonly clock: { now(): Date }) {}
  async list(query: ClaimQuery, reader: ClaimReader): Promise<{ items: ClaimSummary[]; next: string | null }> {
    this.active(reader);
    const page = await this.store.list(query, reader, { highDays: HIGH_PRIORITY_DAYS, mediumDays: MEDIUM_PRIORITY_DAYS, overdueDays: OVERDUE_DAYS });
    this.active(reader);
    const now = this.clock.now();
    return { items: page.records.map(record => summarize(record, now)), next: page.next };
  }
  private active(reader: ClaimReader) {
    if (!(Date.parse(reader.expiresAt) > this.clock.now().getTime())) throw new Error('claims_authorization_expired');
  }
}
