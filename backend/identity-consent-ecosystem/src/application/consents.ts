import { CURRENT_TERMS, PURPOSE_RISK_PROFILING, WORDING_FINGERPRINT, expiryFor, isConsentCode, parseGrantRequest, parseTermsRequest, sealContent, statusOf } from '../domain/consent';
import type { Consent, ConsentStatus, ScopeCode } from '../domain/consent';
import type { Principal } from './authentication';
import type { ConsentStore, Integrity, Platform } from './ports/consents';
import { ConsentCursorNotOwned } from './ports/consents';
import type { SecurityDecisions } from './security-decisions';

export type ConsentView = {
  consentId: string;
  version: number;
  status: ConsentStatus;
  purposeCode: string;
  textVersion: number;
  locale: string;
  wordingHash: string;
  sources: string[];
  scopes: string[];
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  quoteRef: string | null;
  seal: string;
};

export type ConsentCheck = { subjectToken: string; purposeCode: string; scope: string; traceId?: string };
export type ConsentScopesCheck = { subjectToken: string; purposeCode: string; scopes: readonly string[]; traceId?: string };
export type ConsentDecision =
  | { allowed: true; consent: { consentId: string; textVersion: number; expiresAt: string } }
  | { allowed: false; reason: 'invalid_request' | 'consent_missing' | 'consent_revoked' | 'consent_expired' | 'consent_invalid' | 'unavailable' };

const MAX_KEY = 128;
const PAGE_SIZE = 50;
const SCOPES: readonly string[] = CURRENT_TERMS.sources.map(source => source.scope);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID: ConsentDecision = { allowed: false, reason: 'invalid_request' };
const UNAVAILABLE: ConsentDecision = { allowed: false, reason: 'unavailable' };
const isScope = (value: unknown): value is ScopeCode => typeof value === 'string' && SCOPES.includes(value);
const validSubject = (input: { subjectToken?: unknown; purposeCode?: unknown } | null | undefined) =>
  !!input && typeof input.subjectToken === 'string' && UUID.test(input.subjectToken) && input.purposeCode === PURPOSE_RISK_PROFILING;

export class Consents {
  constructor(private readonly deps: { store: ConsentStore; platform: Platform; integrity: Integrity; security?: Pick<SecurityDecisions, 'deny'> }) {}

  terms() { return CURRENT_TERMS; }

  async grant(input: { principal: Principal; idempotencyKey: string | null; body: unknown; traceId: string }) {
    const { store, platform, integrity } = this.deps;
    const request = parseGrantRequest(input.body);
    if (!request || !input.idempotencyKey || input.idempotencyKey.length > MAX_KEY) return { status: 'invalid' } as const;
    const requestHash = await integrity.digest(JSON.stringify([request.textVersion, request.quoteRef, request.locale]));
    if (request.textVersion !== CURRENT_TERMS.textVersion) {
      // A committed authorization remains replayable after a terms revision; stale text cannot create a new grant.
      const existing = await store.findGrant(input.principal, input.idempotencyKey, requestHash);
      if (!existing) return { status: 'terms_outdated' } as const;
      if (existing.kind === 'conflict') return { status: 'idempotency_conflict' } as const;
      return { status: 'replayed', consent: this.view(existing.consent, platform.now()) } as const;
    }
    const grantedAt = platform.now();
    const base = {
      id: platform.newId(), version: 1, clientId: input.principal.clientId, purposeCode: CURRENT_TERMS.purposeCode,
      textVersion: CURRENT_TERMS.textVersion, locale: request.locale, wordingHash: WORDING_FINGERPRINT[request.locale], sources: CURRENT_TERMS.sources.map(s => s.code), scopes: CURRENT_TERMS.sources.map(s => s.scope),
      grantedAt, expiresAt: expiryFor(grantedAt), quoteRef: request.quoteRef
    };
    const result = await store.grant({
      ...base,
      seal: await integrity.seal(sealContent(base)),
      subjectToken: input.principal.subjectToken,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      year: Number(grantedAt.toLocaleString('en-CA', { timeZone: 'America/Bogota', year: 'numeric' })),
      traceId: input.traceId
    });
    if (result.kind === 'conflict') return { status: 'idempotency_conflict' } as const;
    return { status: result.kind, consent: this.view(result.consent, platform.now()) } as const;
  }

  async decline(input: { principal: Principal; body: unknown; traceId: string }) {
    const request = parseTermsRequest(input.body, ['textVersion']);
    if (!request) return { status: 'invalid' } as const;
    if (request.textVersion !== CURRENT_TERMS.textVersion) return { status: 'terms_outdated' } as const;
    await this.deps.store.decline(input.principal, input.traceId);
    return { status: 'declined' } as const;
  }

  async list(principal: Principal, after?: string, traceId?: string) {
    const now = this.deps.platform.now();
    let rows: Consent[];
    try { rows = await this.deps.store.list(principal, PAGE_SIZE + 1, now, after); }
    catch (error) {
      if (!(error instanceof ConsentCursorNotOwned)) throw error;
      await this.deps.security?.deny({ category: 'api_access', channel: 'web', operation: 'consents:read', cause: 'forbidden' }, traceId);
      return { items: [], nextCursor: null };
    }
    const items = rows.slice(0, PAGE_SIZE).map(consent => this.view(consent, now));
    return { items, nextCursor: rows.length > PAGE_SIZE ? items[items.length - 1].consentId : null };
  }

  async revoke(input: { principal: Principal; consentCode: string; traceId: string }) {
    if (!isConsentCode(input.consentCode)) return { status: 'invalid' } as const;
    const now = this.deps.platform.now();
    const result = await this.deps.store.revoke(input.principal, input.consentCode, now, input.traceId);
    if (result.kind === 'not_found') {
      await this.deps.security?.deny({ category: 'api_access', channel: 'web', operation: 'consents:write', cause: 'forbidden' }, input.traceId);
      return { status: 'not_found' } as const;
    }
    if (result.kind === 'not_active') return { status: 'not_active' } as const;
    return { status: 'revoked', consent: this.view(result.consent, now) } as const;
  }

  // Called on every use of a source, never cached: a revocation blocks the next call.
  async verify(input: ConsentCheck): Promise<ConsentDecision> {
    const decision = await this.checkConsent(input);
    return await this.recordDenial(decision, input?.traceId) ? decision : UNAVAILABLE;
  }

  // One fresh read decides several scopes of a single use, with one decision per requested scope in
  // request order. Any technical failure makes every scope unavailable, and one use records one denial.
  async verifyScopes(input: ConsentScopesCheck): Promise<ConsentDecision[]> {
    const decisions = await this.checkScopes(input);
    const denial = decisions.find(decision => !decision.allowed);
    return denial && !await this.recordDenial(denial, input?.traceId) ? decisions.map(() => UNAVAILABLE) : decisions;
  }

  private async recordDenial(decision: ConsentDecision, traceId: unknown): Promise<boolean> {
    if (decision.allowed || decision.reason === 'unavailable') return true;
    try {
      await this.deps.security?.deny({ category: 'consent_use', channel: 'internal', operation: 'consent:use',
        cause: decision.reason === 'invalid_request' ? 'consent_request_invalid' : decision.reason }, traceId);
      return true;
    } catch { return false; }
  }

  private async checkConsent(input: ConsentCheck): Promise<ConsentDecision> {
    if (!validSubject(input) || !isScope(input.scope)) return INVALID;
    try {
      const now = this.deps.platform.now();
      return await this.decide(await this.deps.store.forSubject(input.subjectToken, input.purposeCode, input.scope, now), now);
    } catch {
      return UNAVAILABLE;
    }
  }

  private async checkScopes(input: ConsentScopesCheck): Promise<ConsentDecision[]> {
    const requested: unknown = input?.scopes;
    if (!Array.isArray(requested) || !requested.length || requested.length > SCOPES.length) return [INVALID];
    const scopes = requested.filter(isScope);
    if (!validSubject(input) || scopes.length !== requested.length || new Set(scopes).size !== scopes.length) return requested.map(() => INVALID);
    try {
      const now = this.deps.platform.now();
      const found = await this.deps.store.forSubjectScopes(input.subjectToken, input.purposeCode, scopes, now);
      return await Promise.all(scopes.map(scope => this.decide(found.get(scope) ?? [], now)));
    } catch {
      return scopes.map(() => UNAVAILABLE);
    }
  }

  private async decide(consents: Consent[], now: Date): Promise<ConsentDecision> {
    if (!consents.length) return { allowed: false, reason: 'consent_missing' };
    let tampered = false;
    for (const consent of consents) {
      if (statusOf(consent, now) !== 'active') continue;
      if (await this.deps.integrity.seal(sealContent(consent)) === consent.seal) {
        return { allowed: true, consent: { consentId: consent.consentCode, textVersion: consent.textVersion, expiresAt: consent.expiresAt.toISOString() } };
      }
      tampered = true;
    }
    if (tampered) return { allowed: false, reason: 'consent_invalid' };
    return { allowed: false, reason: statusOf(consents[0], now) === 'revoked' ? 'consent_revoked' : 'consent_expired' };
  }

  private view(consent: Consent, now: Date): ConsentView {
    return {
      consentId: consent.consentCode, version: consent.version, status: statusOf(consent, now), purposeCode: consent.purposeCode,
      textVersion: consent.textVersion, locale: consent.locale, wordingHash: consent.wordingHash, sources: consent.sources, scopes: consent.scopes, grantedAt: consent.grantedAt.toISOString(),
      expiresAt: consent.expiresAt.toISOString(), revokedAt: consent.revokedAt?.toISOString() ?? null, quoteRef: consent.quoteRef, seal: consent.seal
    };
  }
}
