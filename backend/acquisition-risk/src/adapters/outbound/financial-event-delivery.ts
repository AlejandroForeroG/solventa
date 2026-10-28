import type { AcceptanceEvent } from '../../application/ports/offer-store';
import type { FinancialEventQueue } from './financial-outbox-publisher';

export interface PolicyImportService { acceptOfferV1(event: unknown): Promise<unknown> }
type ImportOutcome = 'imported' | 'rejected' | 'unavailable';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// Queue acknowledgement remains the publication receipt. The additional delivery
// imports the same durable signed event through Policy's existing idempotent inbox.
export class FinancialEventDelivery implements FinancialEventQueue {
  constructor(private readonly deps: {
    queue: { send(event: AcceptanceEvent, options: { contentType: 'json' }): Promise<unknown> };
    policy?: PolicyImportService;
    waitUntil(work: Promise<unknown>): void;
    report(input: { eventId: string; traceId: string; outcome: ImportOutcome; durationMs: number }): void;
    importDeadlineMs?: number;
  }) {
    const deadline = deps.importDeadlineMs ?? 750;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 1000) throw new Error('financial_import_deadline_invalid');
  }
  async send(event: AcceptanceEvent): Promise<void> {
    const acknowledged = Promise.resolve().then(() => this.deps.queue.send(event, { contentType: 'json' })).then(() => {
      if (this.deps.policy) this.deps.waitUntil(this.notify(event, this.deps.policy));
    });
    // Keep a Queue write and its continuation alive even if the publisher's wait expires.
    this.deps.waitUntil(acknowledged.then(() => {}, () => {}));
    await acknowledged;
  }
  private async notify(event: AcceptanceEvent, policy: PolicyImportService): Promise<void> {
    const started = performance.now();
    let outcome: ImportOutcome = 'unavailable';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = Promise.resolve().then(() => policy.acceptOfferV1(event));
      // A timeout cannot cancel an import already executing in another Worker.
      this.deps.waitUntil(call.then(() => {}, () => {}));
      const result = await Promise.race([call, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('financial_import_deadline')), this.deps.importDeadlineMs ?? 750);
      })]);
      if (record(result) && result.status === 'ok' && record(result.policy)
        && typeof result.policy.policyId === 'string' && UUID.test(result.policy.policyId)
        && result.policy.offerId === event.payload.offerId && result.policy.offerVersion === event.payload.offerVersion) outcome = 'imported';
      else if (record(result) && result.status === 'denied') outcome = 'rejected';
    } catch { /* Queue remains the durable recovery path; no provider error is exposed. */ }
    finally {
      clearTimeout(timer);
      this.deps.report({ eventId: event.eventId, traceId: event.correlationId, outcome, durationMs: Math.round((performance.now() - started) * 100) / 100 });
    }
  }
}
