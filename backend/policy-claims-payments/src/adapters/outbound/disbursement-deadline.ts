import type { DisbursementDeadline } from '../../application/ports/claim-disbursement';

export class PaymentDeadline implements DisbursementDeadline {
  async race<T>(work: Promise<T>, milliseconds: number, operation?: 'lookup' | 'settle'): Promise<T | 'expired'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    let expired = false;
    try {
      const result = await Promise.race([work, new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), milliseconds); })]);
      expired = result === 'expired'; return result;
    } finally {
      clearTimeout(timer);
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      if (durationMs > 120) console.log(JSON.stringify({ event: 'dependency_budget_exceeded', dependency: 'synthetic-payment-gateway-v1',
        operation, budgetMs: 120, durationMs, expired }));
    }
  }
}
