import { CURRENT_TERMS, PURPOSE_RISK_PROFILING, WORDING_FINGERPRINT, expiryFor, isConsentCode, parseGrantRequest, parseTermsRequest, sealContent, statusOf } from '../domain/consent';
import type { Consent, ConsentStatus } from '../domain/consent';
import type { Principal } from './authentication';
import type { ConsentStore, Integrity, Platform } from './ports/consents';

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

export type ConsentCheck = { subjectToken: string; purposeCode: string; scope: string };
export type ConsentDecision =
  | { allowed: true; consent: { consentId: string; textVersion: number; expiresAt: string } }
  | { allowed: false; reason: 'invalid_request' | 'consent_missing' | 'consent_revoked' | 'consent_expired' | 'consent_invalid' | 'unavailable' };

const MAX_KEY = 128;
const LIST_LIMIT = 50;
const SCOPES: readonly string[] = CURRENT_TERMS.sources.map(source => source.scope);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Consents {
  constructor(private readonly deps: { store: ConsentStore; platform: Platform; integrity: Integrity }) {}

  terms() { return CURRENT_TERMS; }

  async grant(input: { principal: Principal; idempotencyKey: string | null; body: unknown; traceId: string }) {
    const { store, platform, integrity } = this.deps;
    const request = parseGrantRequest(input.body);
    if (!request || !input.idempotencyKey || input.idempotencyKey.length > MAX_KEY) return { status: 'invalid' } as const;
    if (request.textVersion !== CURRENT_TERMS.textVersion) return { status: 'terms_outdated' } as const;
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
      requestHash: await integrity.digest(JSON.stringify([request.textVersion, request.quoteRef, request.locale])),
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

  async list(principal: Principal) {
    const now = this.deps.platform.now();
    return (await this.deps.store.list(principal, LIST_LIMIT, now)).map(consent => this.view(consent, now));
  }

  async revoke(input: { principal: Principal; consentCode: string; traceId: string }) {
    if (!isConsentCode(input.consentCode)) return { status: 'invalid' } as const;
    const now = this.deps.platform.now();
    const result = await this.deps.store.revoke(input.principal, input.consentCode, now, input.traceId);
    if (result.kind === 'not_found') return { status: 'not_found' } as const;
    if (result.kind === 'not_active') return { status: 'not_active' } as const;
    return { status: 'revoked', consent: this.view(result.consent, now) } as const;
  }

  // Called on every use of a source, never cached: a revocation blocks the next call.
  async verify(input: ConsentCheck): Promise<ConsentDecision> {
    if (!input || typeof input.subjectToken !== 'string' || !UUID.test(input.subjectToken) || input.purposeCode !== PURPOSE_RISK_PROFILING
      || typeof input.scope !== 'string' || !SCOPES.includes(input.scope)) return { allowed: false, reason: 'invalid_request' };
    try {
      const now = this.deps.platform.now();
      const consents = await this.deps.store.forSubject(input.subjectToken, input.purposeCode, input.scope, now);
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
    } catch {
      return { allowed: false, reason: 'unavailable' };
    }
  }

  private view(consent: Consent, now: Date): ConsentView {
    return {
      consentId: consent.consentCode, version: consent.version, status: statusOf(consent, now), purposeCode: consent.purposeCode,
      textVersion: consent.textVersion, locale: consent.locale, wordingHash: consent.wordingHash, sources: consent.sources, scopes: consent.scopes, grantedAt: consent.grantedAt.toISOString(),
      expiresAt: consent.expiresAt.toISOString(), revokedAt: consent.revokedAt?.toISOString() ?? null, quoteRef: consent.quoteRef, seal: consent.seal
    };
  }
}
