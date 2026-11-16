import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { underwrite, type OfferCapture, type OfferSignalSource } from '../backend/acquisition-risk/src/domain/offer';
import { SIGNAL_SCOPES, type Signal } from '../backend/acquisition-risk/src/domain/signal';
import { reconstructMortgageDecision } from '../backend/acquisition-risk/src/domain/reconstruct-mortgage-decision';

const traceId = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-16T10:00:00.000Z';
const authorization = { consentId: 'CNS-2026-00001', textVersion: 1, expiresAt: '2026-10-16T11:00:00.000Z' };
const quote = { id: traceId, quoteId: 'COT-2026-00001', amount: 320000000, ageYears: 35, termMonths: 180, validUntil: '2026-11-01T10:00:00.000Z' };
const validate = new Ajv().compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
function fixture(changes: { score?: number; debt?: number; identity?: boolean; affiliation?: boolean; provenance?: OfferSignalSource[]; amount?: number; age?: number } = {}) {
  const signals: Signal[] = [
    { scope: 'income_obligations_12m', capturedAt: at, data: { monthlyIncomeCop: 8000000, monthlyObligationsCop: changes.debt ?? 2000000 } },
    { scope: 'payment_history_score', capturedAt: at, data: { score: changes.score ?? 780 } },
    { scope: 'affiliation_regime', capturedAt: at, data: { active: changes.affiliation ?? true } },
    { scope: 'identity_validation', capturedAt: at, data: { verified: changes.identity ?? true } }
  ];
  const decision = underwrite({ ...quote, amount: changes.amount ?? quote.amount, ageYears: changes.age ?? quote.ageYears }, signals, authorization, traceId, changes.provenance);
  assert.ok(decision);
  return { decision, signals };
}

test('the actual underwriting capture reconstructs its inputs, consent, sources, historical artifacts and exact premium', () => {
  const { decision, signals } = fixture();
  assert.equal(validate(decision.capture), true, JSON.stringify(validate.errors));
  const reconstructed = reconstructMortgageDecision(JSON.parse(JSON.stringify(decision.capture)));
  assert.equal(reconstructed.status, 'reconstructed');
  if (reconstructed.status !== 'reconstructed') throw Error('reconstruction failed');
  assert.equal(reconstructed.calculatedPremium, '77760.0000');
  assert.equal(reconstructed.calculatedPremium, decision.premium);
  assert.equal(reconstructed.outcome, 'accepted');
  assert.deepEqual(reconstructed.consent, { status: 'verified', id: authorization.consentId, version: 1 });
  assert.deepEqual(reconstructed.rule, { id: 'mortgage-underwriting', version: 'academic-mortgage-1' });
  assert.deepEqual(reconstructed.baseRule, { id: 'quote-rating', version: 'provisional-1' });
  assert.deepEqual(reconstructed.model, { status: 'not_used' });
  assert.equal(reconstructed.sources.length, 4);
  assert.equal(reconstructed.inputs.monthlyObligationsCop, 2000000);
  assert.equal(reconstructed.inputs.identityVerified, true);
  assert.equal(reconstructed.inputs.affiliationActive, true);
  // Mutating today's sources cannot rewrite an already serialized historical capture.
  signals[3].data = { verified: false };
  assert.deepEqual(reconstructMortgageDecision(decision.capture), reconstructed);
});

test('every rejection condition is explainable from captured facts, including identity and affiliation failures', () => {
  for (const [change, check] of [
    [{ identity: false }, 'identityVerified'], [{ affiliation: false }, 'affiliationActive'],
    [{ score: 599 }, 'paymentScoreSufficient'], [{ debt: 4000008 }, 'debtRatioWithinLimit'],
    [{ amount: 1000000000000000 }, 'amountWithinLimit']
  ] as const) {
    const { decision } = fixture(change);
    assert.equal(decision.capture.outcome, 'declined');
    assert.equal(validate(decision.capture), true);
    const result = reconstructMortgageDecision(decision.capture);
    assert.equal(result.status, 'reconstructed');
    if (result.status !== 'reconstructed') throw Error('decline reconstruction failed');
    assert.equal(result.outcome, 'declined');
    assert.equal(result.checks[check], false);
  }
});

test('historical score, debt-ratio, age-band and rounding boundaries retain their original tariff', () => {
  for (const [changes, premium, discount] of [
    [{ score: 600, debt: 4000000 }, '86400.0000', false],
    [{ score: 750, debt: 2400000 }, '77760.0000', true],
    [{ score: 749 }, '86400.0000', false],
    [{ debt: 2400008 }, '86400.0000', false],
    [{ age: 30 }, '63360.0000', true],
    [{ age: 31 }, '77760.0000', true],
    [{ age: 41 }, '115200.0000', true],
    [{ age: 51 }, '187200.0000', true],
    [{ age: 61 }, '288000.0000', true],
    [{ amount: 5556 }, '2.0000', true]
  ] as const) {
    const result = reconstructMortgageDecision(fixture(changes).decision.capture);
    if (result.status !== 'reconstructed') throw Error('boundary reconstruction failed');
    assert.equal(result.calculatedPremium, premium);
    assert.equal(result.checks.discountApplied, discount);
  }
});

test('degraded historical sources remain preliminary even when the numerical underwriting checks pass', () => {
  for (const substitute of ['stored_copy', 'default'] as const) {
    const provenance: OfferSignalSource[] = SIGNAL_SCOPES.map(scope => scope === 'payment_history_score'
      ? { scope, quality: substitute, degraded: true, failure: 'timeout', substitute, confidence: substitute === 'stored_copy' ? 60 : 0 }
      : { scope, quality: 'live', degraded: false, confidence: 100 });
    const { decision } = fixture({ provenance });
    const result = reconstructMortgageDecision(decision.capture);
    if (result.status !== 'reconstructed') throw Error('degraded reconstruction failed');
    assert.equal(result.outcome, 'preliminary');
    assert.equal(result.sources[1].failure, 'timeout');
    assert.equal(result.sources[1].substitute, substitute);
    assert.equal(result.calculatedPremium, decision.premium);
    assert.equal(validate(decision.capture), true);
  }
});

test('legacy captures missing facts are explicitly incomplete without inferred identity, affiliation or model', () => {
  const capture = fixture().decision.capture;
  const { monthlyIncomeCop: _income, monthlyObligationsCop: _debt, identityVerified: _identity, affiliationActive: _affiliation, ...legacy } = capture.inputs;
  assert.deepEqual(reconstructMortgageDecision({ ...capture, inputs: legacy }), { status: 'incomplete_capture', missing: [
    'inputs.monthlyIncomeCop', 'inputs.monthlyObligationsCop', 'inputs.identityVerified', 'inputs.affiliationActive'
  ] });
  assert.deepEqual(reconstructMortgageDecision({ ...capture, rule: { ...capture.rule, version: 'academic-mortgage-2' } }), { status: 'unsupported_rule' });
  assert.deepEqual(reconstructMortgageDecision({ ...capture, inputs: { ...capture.inputs, baseRuleVersion: 'provisional-2' } }), { status: 'unsupported_rule' });
  assert.deepEqual(reconstructMortgageDecision({ ...capture, model: { id: 'invented', version: '1' } }), { status: 'unsupported_model' });
});

test('changed derived facts or outcome cannot pass as a consistent historical decision', () => {
  const capture = fixture().decision.capture;
  for (const change of [{ debtRatioPpm: 1 }, { adjustmentPpm: 1 }, { baseRatePpm: 1 }, { identityVerified: false }, { affiliationActive: false }]) {
    assert.deepEqual(reconstructMortgageDecision({ ...capture, inputs: { ...capture.inputs, ...change } }), { status: 'inconsistent_capture' });
  }
  assert.deepEqual(reconstructMortgageDecision({ ...capture, outcome: 'declined' }), { status: 'inconsistent_capture' });
});

test('malformed stored JSON, invalid numbers and invalid provenance fail without returning stored content', () => {
  const capture = fixture().decision.capture;
  const badSources = [[], [...capture.sources.slice(0, 3), capture.sources[0]],
    capture.sources.map(source => ({ ...source, capturedAt: '2026-02-30T10:00:00Z' })),
    capture.sources.map(source => ({ ...source, degraded: true })),
    capture.sources.map(source => ({ ...source, confidence: 101 }))];
  for (const value of [null, [], 'private invalid body', {}, { ...capture, consent: { status: 'verified' } },
    { ...capture, correlationId: 'not-a-uuid' }, { ...capture, schemaVersion: 2 },
    ...badSources.map(sources => ({ ...capture, sources }))]) {
    assert.deepEqual(reconstructMortgageDecision(value), { status: 'invalid_capture' });
  }
  for (const change of [{ monthlyIncomeCop: 0 }, { paymentScore: 1001 }, { monthlyObligationsCop: -1 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { ageYears: 17 }, { identityVerified: 'true' }]) {
    assert.deepEqual(reconstructMortgageDecision({ ...capture, inputs: { ...capture.inputs, ...change } }), { status: 'invalid_capture' });
  }
});

test('the reconstruction is detached and exposes only the recognized historical fields', () => {
  const capture: OfferCapture = fixture().decision.capture;
  const result = reconstructMortgageDecision({ ...capture, privateField: 'not-returned',
    inputs: { ...capture.inputs, privateField: 'not-returned' }, sources: capture.sources.map(source => ({ ...source, privateField: 'not-returned' })) });
  assert.equal(result.status, 'reconstructed');
  assert.equal(JSON.stringify(result).includes('not-returned'), false);
  const before = JSON.stringify(capture);
  if (result.status !== 'reconstructed') throw Error('reconstruction failed');
  result.inputs.identityVerified = false;
  result.sources[0].source = 'changed';
  result.consent.id = 'changed';
  assert.equal(JSON.stringify(capture), before);
});
