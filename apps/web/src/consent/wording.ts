export const SUPPORTED_TEXT_VERSION = 1;

// The semantics this version's localized wording describes. Refuse different terms before showing authorization.
export const SUPPORTED_TERMS = {
  purposeCode: 'risk_profiling', textVersion: SUPPORTED_TEXT_VERSION, validityDays: 90,
  sources: [
    { code: 'open_finance_bancolombia', scope: 'income_obligations_12m', kind: 'open_finance' },
    { code: 'datacredito_experian', scope: 'payment_history_score', kind: 'credit_bureau' },
    { code: 'ruaf', scope: 'affiliation_regime', kind: 'open_data' },
    { code: 'registraduria', scope: 'identity_validation', kind: 'open_data' }
  ]
} as const;

// The messages that make up what the customer reads and accepts. Changing any of them requires a new text version
// and the new fingerprints in Identity: a test compares both.
export const CONSENT_WORDING_KEYS = [
  'consent.purpose', 'consent.purposeText', 'consent.purposeNote', 'consent.validity', 'consent.validityDays', 'consent.validityRange',
  'consent.revokeNote', 'consent.sources', 'consent.dane', 'consent.check',
  'source.open_finance_bancolombia.name', 'source.open_finance_bancolombia.detail',
  'source.datacredito_experian.name', 'source.datacredito_experian.detail',
  'source.ruaf.name', 'source.ruaf.detail',
  'source.registraduria.name', 'source.registraduria.detail',
  'kind.open_finance', 'kind.credit_bureau', 'kind.open_data',
  'scope.income_obligations_12m', 'scope.payment_history_score', 'scope.affiliation_regime', 'scope.identity_validation'
] as const;
