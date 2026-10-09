import type { Principal } from '../../backend/identity-consent-ecosystem/src/application/authentication';
import type { ConsentStore, GrantResult, NewConsent, RevokeResult } from '../../backend/identity-consent-ecosystem/src/application/ports/consents';
import type { Consent } from '../../backend/identity-consent-ecosystem/src/domain/consent';
import { statusOf } from '../../backend/identity-consent-ecosystem/src/domain/consent';

export const SEAL_KEY = 'synthetic-seal-key-for-tests-only-0123456789';
export const ANA: Principal = { clientId: '11111111-1111-4111-8111-111111111111', subjectToken: '21111111-1111-4111-8111-111111111111' };
export const LUIS: Principal = { clientId: '12222222-2222-4222-8222-222222222222', subjectToken: '22222222-2222-4222-8222-222222222222' };
export const TRACE = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';

export class MemoryConsents implements ConsentStore {
  readonly consents: (Consent & { subjectToken: string; idempotencyKey: string; requestHash: string })[] = [];
  readonly audit: { action: string; subjectToken: string }[] = [];
  readonly outbox: string[] = [];
  failing = false;
  private counter = 0;

  private check() { if (this.failing) throw new Error('store_down'); }

  async grant(c: NewConsent): Promise<GrantResult> {
    this.check();
    const existing = this.consents.find(x => x.clientId === c.clientId && x.idempotencyKey === c.idempotencyKey);
    if (existing) return existing.requestHash === c.requestHash ? { kind: 'replayed', consent: existing } : { kind: 'conflict' };
    const consent = { ...c, consentCode: `CNS-${c.year}-${String(++this.counter).padStart(5, '0')}`, revokedAt: null };
    this.consents.push(consent);
    this.audit.push({ action: 'consent.granted', subjectToken: c.subjectToken });
    this.outbox.push('consent.granted');
    return { kind: 'created', consent };
  }

  async list(principal: Principal, historyLimit: number, now: Date): Promise<Consent[]> {
    this.check();
    const owned = this.consents.filter(c => c.clientId === principal.clientId);
    const newest = (a: Consent, b: Consent) => b.grantedAt.getTime() - a.grantedAt.getTime() || a.id.localeCompare(b.id);
    return [...owned.filter(c => statusOf(c, now) === 'active'),
      ...owned.filter(c => statusOf(c, now) !== 'active').sort(newest).slice(0, historyLimit)].sort(newest);
  }

  async revoke(principal: Principal, consentCode: string, now: Date): Promise<RevokeResult> {
    this.check();
    const consent = this.consents.find(c => c.clientId === principal.clientId && c.consentCode === consentCode);
    if (!consent) return { kind: 'not_found' };
    if (consent.revokedAt) return { kind: 'already_revoked', consent };
    if (statusOf(consent, now) === 'expired') return { kind: 'not_active', consent };
    consent.revokedAt = now;
    this.audit.push({ action: 'consent.revoked', subjectToken: principal.subjectToken });
    this.outbox.push('consent.revoked');
    return { kind: 'revoked', consent };
  }

  async decline(principal: Principal): Promise<void> {
    this.check();
    this.audit.push({ action: 'consent.declined', subjectToken: principal.subjectToken });
  }

  async forSubject(subjectToken: string, purposeCode: string, scope: string): Promise<Consent[]> {
    this.check();
    return this.consents.filter(c => c.subjectToken === subjectToken && c.purposeCode === purposeCode && (c.scopes as string[]).includes(scope))
      .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
  }
}

export function clock(start = '2026-10-08T15:00:00Z') {
  let current = new Date(start);
  let ids = 0;
  return {
    now: () => new Date(current),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    advance: (days: number) => { current = new Date(current.getTime() + days * 24 * 60 * 60 * 1000); }
  };
}
