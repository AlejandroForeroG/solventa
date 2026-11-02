import type { AcceptanceEvent } from '../../application/ports/offer-store';

export interface PolicyImportService { acceptOfferV1(event: unknown): Promise<unknown> }
type ImportOutcome = 'imported' | 'rejected' | 'unavailable';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// The HTTP adapter schedules this only after the owner's acceptance commit.
// Queue publication independently retains the leased outbox recovery path.
export class FinancialEventDelivery {
  constructor(private readonly deps: {
    policy?: PolicyImportService;
    waitUntil(work: Promise<unknown>): void;
    report(input: { eventId: string; traceId: string; outcome: ImportOutcome; durationMs: number }): void;
    importDeadlineMs?: number;
  }) {
    const deadline = deps.importDeadlineMs ?? 750;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 1000) throw new Error('financial_import_deadline_invalid');
  }
  async send(event: AcceptanceEvent): Promise<void> {
    const policy = this.deps.policy;
    if (!policy) return;
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
