import type { ExpiryAnnouncer } from './ports/notice';

// A policy is announced once when its expiry is at most this far away. The announcement is stored with the same shape as every other notice,
// so the customer's choices decide later whether it reaches a device; nothing here sends anything.
export const EXPIRY_WINDOW_MS = 7 * 24 * 3600 * 1000;

export class ExpiryNotices {
  constructor(private readonly announcer: ExpiryAnnouncer, private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  // Returns how many policies were announced by this run; a policy already announced for its expiry date is not announced again.
  async run(): Promise<number> {
    return this.announcer.announceExpiring(this.clock.now(), EXPIRY_WINDOW_MS);
  }
}
