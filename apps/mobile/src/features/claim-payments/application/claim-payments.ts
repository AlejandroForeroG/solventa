import type { ClaimPaymentPage } from '@solventa/contracts';
import { ClaimPaymentFailure, type PaymentScreenState } from '../domain/payment';

export interface ClaimPaymentsApi { list(cursor: string | undefined, signal: AbortSignal): Promise<ClaimPaymentPage> }
export class ClaimPayments {
  private state: PaymentScreenState = { status: 'locked' };
  private listeners = new Set<() => void>();
  private cursor: string | undefined;
  private previous: (string | undefined)[] = [];
  private request: AbortController | undefined;
  constructor(private readonly api: ClaimPaymentsApi) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: PaymentScreenState) { this.state = state; for (const listener of this.listeners) listener(); }
  lock() { this.request?.abort(); this.publish({ status: 'locked' }); }
  async refresh() {
    this.request?.abort(); const request = new AbortController(); this.request = request;
    this.publish({ status: 'loading' });
    try {
      const page = await this.api.list(this.cursor, request.signal);
      if (!request.signal.aborted) this.publish({ status: 'ready', page, hasPrevious: this.previous.length > 0 });
    } catch (error) {
      if (!request.signal.aborted) this.publish({ status: 'failed', failure: error instanceof ClaimPaymentFailure ? error.code : 'unavailable' });
    }
  }
  async next() {
    if (this.state.status !== 'ready' || !this.state.page.next) return;
    this.previous.push(this.cursor); this.cursor = this.state.page.next; await this.refresh();
  }
  async back() { if (!this.previous.length) return; this.cursor = this.previous.pop(); await this.refresh(); }
}
