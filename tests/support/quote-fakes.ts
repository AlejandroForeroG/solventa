import { createHash } from 'node:crypto';
import type { AccessCredential, AccessDecision, ApiAccess, QuoteActor } from '../../backend/acquisition-risk/src/application/ports/api-access';
import type { NewQuote, QuoteStore, SaveResult } from '../../backend/acquisition-risk/src/application/ports/quote-store';

export const PARTNER_ID = '10000000-0000-4000-8000-000000000001';
export const USER_ACTOR: QuoteActor = { kind: 'user', clientId: '30000000-0000-4000-8000-000000000001', subjectToken: '40000000-0000-4000-8000-000000000001' };
export const OTHER_USER_ACTOR: QuoteActor = { kind: 'user', clientId: '30000000-0000-4000-8000-000000000002', subjectToken: '40000000-0000-4000-8000-000000000002' };

export const PARTNER: AccessCredential = { kind: 'partner', token: 'partner-token' };
export const WEB: AccessCredential = { kind: 'web', cookie: 'sealed-cookie', origin: 'https://web.example', method: 'POST' };

const denied = (status: 401 | 403 | 503): AccessDecision => ({ allowed: false, status, error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'access_unavailable' });

export class InMemoryAccess implements ApiAccess {
  calls: AccessCredential[] = [];
  async authorize(credential: AccessCredential): Promise<AccessDecision> {
    this.calls.push(credential);
    if (credential.kind === 'partner') {
      if (credential.token === 'partner-token') return { allowed: true, actor: { kind: 'partner', partnerId: PARTNER_ID } };
      if (credential.token === 'no-scope-token') return denied(403);
      if (credential.token === 'down-token') return denied(503);
      return denied(401);
    }
    if (credential.cookie === 'sealed-cookie') return { allowed: true, actor: USER_ACTOR };
    if (credential.cookie === 'other-user-cookie') return { allowed: true, actor: OTHER_USER_ACTOR };
    if (credential.cookie === 'forbidden-origin-cookie') return denied(403);
    return denied(401);
  }
}

const actorId = (actor: QuoteActor) => (actor.kind === 'partner' ? actor.partnerId : actor.clientId);

export class MemoryStore implements QuoteStore {
  saved: NewQuote[] = [];
  private byKey = new Map<string, { fingerprint: string; quoteId: string; row: NewQuote }>();
  async save(q: NewQuote): Promise<SaveResult> {
    const id = `${actorId(q.actor)}:${q.subjectToken}:${q.idempotencyKey}`;
    const existing = this.byKey.get(id);
    const toQuote = (quoteId: string, row: NewQuote) => ({ quoteId, premiumMonthly: row.premiumMonthly, sumInsured: row.amount, termMonths: row.termMonths, validUntil: row.validUntil, ruleVersion: row.ruleVersion });
    if (existing) return existing.fingerprint === q.requestFingerprint ? { kind: 'replayed', quote: toQuote(existing.quoteId, existing.row) } : { kind: 'conflict' };
    const quoteId = `COT-2026-${String(this.saved.length + 1).padStart(5, '0')}`;
    this.saved.push(q);
    this.byKey.set(id, { fingerprint: q.requestFingerprint, quoteId, row: q });
    return { kind: 'created', quote: toQuote(quoteId, q) };
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

// Like the real protector, they reveal nothing about their input.
export const protector = {
  fingerprint: async (id: string, request: unknown) => digest(`${id}:${JSON.stringify(request)}`),
  documentToken: async (doc: string) => digest(`document:${doc}`)
};
