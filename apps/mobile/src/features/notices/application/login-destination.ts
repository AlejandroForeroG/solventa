import { uuid } from '../domain/notice';

let pending: { eventId: string; startedAt: number } | null = null;
const TTL = 15 * 60 * 1000;

// Only an explicit sign-in from a notice sets this in-memory continuation. It contains no session or business data.
export function rememberNoticeLogin(eventId: string, now = Date.now()): void {
  pending = uuid(eventId) ? { eventId: eventId.toLowerCase(), startedAt: now } : null;
}
export function clearNoticeLogin(): void { pending = null; }
export function consumeNoticeLogin(now = Date.now()): string | null {
  const current = pending;
  pending = null;
  return current && now >= current.startedAt && now - current.startedAt < TTL ? current.eventId : null;
}
