export const PURPOSE_RISK_PROFILING = 'risk_profiling';
export const VALIDITY_DAYS = 90;

export type SourceCode = 'open_finance_bancolombia' | 'datacredito_experian' | 'ruaf' | 'registraduria';
export type ScopeCode = 'income_obligations_12m' | 'payment_history_score' | 'affiliation_regime' | 'identity_validation';
export type ConsentStatus = 'active' | 'revoked' | 'expired';
export const LOCALES = ['es-CO', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];
export type TermsSource = { code: SourceCode; scope: ScopeCode; kind: 'open_finance' | 'credit_bureau' | 'open_data' };

// Any change to the purpose, a source, a scope, the validity or the displayed wording needs a new textVersion.
export const CURRENT_TERMS = {
  purposeCode: PURPOSE_RISK_PROFILING,
  textVersion: 2,
  validityDays: VALIDITY_DAYS,
  sources: [
    { code: 'open_finance_bancolombia', scope: 'income_obligations_12m', kind: 'open_finance' },
    { code: 'datacredito_experian', scope: 'payment_history_score', kind: 'credit_bureau' },
    { code: 'ruaf', scope: 'affiliation_regime', kind: 'open_data' },
    { code: 'registraduria', scope: 'identity_validation', kind: 'open_data' }
  ] satisfies TermsSource[]
};

// Fingerprint of the exact wording the customer reads in each language for the current text version. The web
// catalogue is compared with it by a test, so a wording change cannot reach a record without a new version.
export const WORDING_FINGERPRINT: Record<Locale, string> = {
  'es-CO': '9d05083e2bbd75b3ec4efb6c0fc7c3ab9d5042e42ef1374cec39491444a667ad',
  'en-US': '9f6acbbbe59612ae239bfe49db5945ed9879cc86c21247f6d8907360ffa841e8'
};

export type Consent = {
  id: string;
  consentCode: string;
  version: number;
  clientId: string;
  purposeCode: string;
  textVersion: number;
  locale: Locale;
  wordingHash: string;
  sources: SourceCode[];
  scopes: ScopeCode[];
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  quoteRef: string | null;
  seal: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTE_REF = /^COT-[0-9]{4}-[0-9]{5}$/;
const CONSENT_CODE = /^CNS-[0-9]{4}-[0-9]{5,19}$/;

export const isConsentCode = (value: unknown): value is string => typeof value === 'string' && CONSENT_CODE.test(value);
export const expiryFor = (grantedAt: Date) => new Date(grantedAt.getTime() + VALIDITY_DAYS * DAY_MS);

// A revocation wins over expiry: a revoked consent stays revoked after its date has passed.
export function statusOf(consent: Pick<Consent, 'revokedAt' | 'expiresAt'>, now: Date): ConsentStatus {
  if (consent.revokedAt) return 'revoked';
  return consent.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

export type TermsRequest = { textVersion: number; quoteRef: string | null };
export type GrantRequest = TermsRequest & { locale: Locale };

export function parseTermsRequest(body: unknown, allowed: readonly string[]): TermsRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) return null;
  const { textVersion, quoteRef } = record;
  if (typeof textVersion !== 'number' || !Number.isInteger(textVersion) || textVersion < 1) return null;
  if (quoteRef !== undefined && (typeof quoteRef !== 'string' || !QUOTE_REF.test(quoteRef))) return null;
  return { textVersion, quoteRef: typeof quoteRef === 'string' ? quoteRef : null };
}

export function parseGrantRequest(body: unknown): GrantRequest | null {
  const request = parseTermsRequest(body, ['textVersion', 'quoteRef', 'locale']);
  const locale = (body as Record<string, unknown> | null)?.locale;
  return request && LOCALES.some(known => known === locale) ? { ...request, locale: locale as Locale } : null;
}

// Canonical text sealed at grant time. Revocation is left out: it changes later and has its own audit event.
export const sealContent = (c: Omit<Consent, 'consentCode' | 'revokedAt' | 'seal'>) => JSON.stringify([
  c.id, c.version, c.clientId, c.purposeCode, c.textVersion, c.locale, c.wordingHash, [...c.sources].sort(), [...c.scopes].sort(),
  c.grantedAt.toISOString(), c.expiresAt.toISOString(), c.quoteRef
]);
