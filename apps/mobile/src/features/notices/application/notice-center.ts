import type { Notice, ReceiptOutcome } from '../domain/notice';
import type { NoticePresenter, NoticesApi, PushPermission } from './ports';

export type NoticeSnapshot = { status: 'idle' | 'loading' | 'ready' | 'failed'; notices: readonly Notice[] };
type Dependencies = { api: NoticesApi; presenter: NoticePresenter; permission: PushPermission };

// Collects the notices the server offers to this device, shows each one once and tells the server what happened.
// The transport is simulated: nothing here is evidence that a notice was seen unless the server stored the receipt.
export class NoticeCenter {
  private snapshot: NoticeSnapshot = { status: 'idle', notices: [] };
  private running = false;
  // Changes when the session ends, so that work started for one customer never touches what comes after.
  private epoch = 0;
  // Notices already shown whose receipt could not be delivered: the next collection retries only the receipt, never the presentation.
  private readonly unreported = new Map<string, ReceiptOutcome>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: Dependencies) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    if (this.snapshot.status !== 'ready') this.emit({ ...this.snapshot, status: 'loading' });
    try {
      const notices = await this.deps.api.list();
      if (epoch !== this.epoch) return;
      let current: readonly Notice[] = notices;
      this.emit({ status: 'ready', notices: current });
      for (const notice of notices) {
        if (notice.state !== 'offered' && notice.state !== 'unconfirmed') continue;
        const outcome = this.unreported.get(notice.eventId) ?? await this.deliver(notice, epoch);
        if (epoch !== this.epoch) return;
        // Without a certain outcome nothing is reported: the notice stays offered and the next collection tries again.
        if (!outcome) continue;
        this.unreported.set(notice.eventId, outcome);
        try { await this.deps.api.receipt(notice.eventId, outcome); } catch { continue; }
        this.unreported.delete(notice.eventId);
        if (epoch !== this.epoch) return;
        current = current.map(item => item.eventId === notice.eventId ? { ...item, state: outcome } : item);
        this.emit({ status: 'ready', notices: current });
      }
    } catch {
      if (epoch === this.epoch) this.emit({ ...this.snapshot, status: 'failed' });
    } finally { if (epoch === this.epoch) this.running = false; }
  }

  // The session ended or another customer signed in: nothing of the previous one stays.
  clear() {
    this.epoch++;
    this.running = false;
    this.unreported.clear();
    if (this.snapshot.status !== 'idle' || this.snapshot.notices.length) this.emit({ status: 'idle', notices: [] });
  }

  private async deliver(notice: Notice, epoch: number): Promise<ReceiptOutcome | null> {
    try {
      // The operating system's permission is device-local: without it the notice is reported as not presentable, never as presented.
      const granted = await this.deps.permission.granted();
      // The session may have ended while the permission was being read: nothing is shown to whoever is next.
      if (epoch !== this.epoch) return null;
      if (!granted) return 'permission_denied';
      await this.deps.presenter.present(notice);
      return 'presented';
    } catch { return null; }
  }

  private emit(snapshot: NoticeSnapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
