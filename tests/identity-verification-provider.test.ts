import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { KycProvider, normalizeKycReply, syntheticKycFormat } from '../backend/identity-consent-ecosystem/src/adapters/outbound/kyc-provider';
import { VerificationProviderFailure } from '../backend/identity-consent-ecosystem/src/application/ports/identity-verification';
import { retainedVerificationInputs, verificationOutcome, verificationSteps } from '../backend/identity-consent-ecosystem/src/domain/identity-verification';
import type { VerificationEvaluation, VerificationInputs } from '../backend/identity-consent-ecosystem/src/domain/identity-verification';

const id = '11111111-1111-4111-8111-111111111111';
const evidence: VerificationInputs = {
  document: { reference: 'synthetic-document', sha256: 'a'.repeat(64), corpusVersion: 'test.v1' },
  selfie: { reference: 'synthetic-selfie', sha256: 'b'.repeat(64), corpusVersion: 'test.v1' },
  liveness: { reference: 'synthetic-liveness', sha256: 'c'.repeat(64), corpusVersion: 'test.v1' },
};
const reply = () => ({ formatVersion: syntheticKycFormat, evaluationId: id, providerReference: id, simulated: true,
  completedAt: '2026-10-21T15:00:00.000Z', checks: { document: 'pass', selfie: 'pass', liveness: 'pass' }, screening: 'clear' });
const evaluation = () => normalizeKycReply(reply(), id);
const rejected = (code: string) => (error: unknown) => error instanceof VerificationProviderFailure && error.code === code;

type CorpusCase = { name: string; response: unknown; expected: { outcome: string; retainedSteps: string[] } | { failure: string; schemaValid: boolean } };
const corpus: { evaluationId: string; cases: CorpusCase[] } = JSON.parse(readFileSync('packages/contracts/examples/identity-verification-provider.json', 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validates = ajv.compile(JSON.parse(readFileSync('packages/contracts/schemas/identity-verification-provider.v1.json', 'utf8')));
for (const item of corpus.cases) {
  test(`synthetic KYC corpus: ${item.name}`, async () => {
    const provider = new KycProvider(async () => item.response, 100);
    const pending = provider.evaluate({ evaluationId: corpus.evaluationId, evidence });
    if ('failure' in item.expected) {
      assert.equal(validates(item.response), item.expected.schemaValid, JSON.stringify(validates.errors));
      await assert.rejects(pending, rejected(item.expected.failure));
    } else {
      assert.equal(validates(item.response), true, JSON.stringify(validates.errors));
      const result = await pending;
      assert.equal(verificationOutcome(result), item.expected.outcome);
      assert.deepEqual(Object.keys(retainedVerificationInputs(evidence, result)), item.expected.retainedSteps);
    }
  });
}

test('only three passed checks and clear screening yield a simulated approval', () => {
  assert.equal(verificationOutcome(evaluation()), 'approved');
  for (const step of verificationSteps) {
    const failed = evaluation();
    failed.checks[step] = 'fail';
    assert.equal(verificationOutcome(failed), 'not_verified', step);
    const retained = retainedVerificationInputs(evidence, failed);
    assert.equal(retained[step], undefined);
    for (const other of verificationSteps.filter(value => value !== step)) assert.deepEqual(retained[other], evidence[other]);
  }
});

test('screening matches and review checks require review without asserting a definitive business rejection', () => {
  for (const screening of ['match', 'review'] as const) assert.equal(verificationOutcome({ ...evaluation(), screening }), 'review');
  for (const step of verificationSteps) {
    const pending = evaluation();
    pending.checks[step] = 'review';
    assert.equal(verificationOutcome(pending), 'review');
    assert.equal(retainedVerificationInputs(evidence, pending)[step], undefined);
  }
});

test('retained evidence is copied and cannot mutate the previous attempt inputs', () => {
  const retained = retainedVerificationInputs(evidence, evaluation());
  assert.ok(retained.document);
  retained.document.reference = 'changed';
  assert.equal(evidence.document.reference, 'synthetic-document');
});

test('the adapter translates a valid response and always identifies simulation', async () => {
  const provider = new KycProvider(async input => {
    assert.deepEqual(input, { evaluationId: id, evidence });
    return reply();
  }, 100);
  const result = await provider.evaluate({ evaluationId: id, evidence });
  assert.deepEqual(result, { evaluationId: id, providerReference: id, providerVersion: syntheticKycFormat, simulated: true,
    completedAt: '2026-10-21T15:00:00.000Z', checks: { document: 'pass', selfie: 'pass', liveness: 'pass' }, screening: 'clear' });
});

test('malformed, foreign, incomplete and non-simulated responses never become approvals', () => {
  const invalid: unknown[] = [null, [], {}, { ...reply(), evaluationId: 'another-attempt' }, { ...reply(), simulated: false },
    { ...reply(), formatVersion: 'synthetic-kyc.v2' }, { ...reply(), providerReference: 'personal-document-number' },
    { ...reply(), completedAt: '2026-02-30T15:00:00.000Z' }, { ...reply(), completedAt: 'not-a-date' },
    { ...reply(), checks: null }, { ...reply(), checks: { document: 'pass', selfie: 'pass' } },
    { ...reply(), checks: { ...reply().checks, document: 'approved' } }, { ...reply(), screening: 'unknown' },
    { ...reply(), checks: { ...reply().checks, extra: 'pass' } }, { ...reply(), personalData: 'must-not-be-kept' }];
  for (const value of invalid) assert.throws(() => normalizeKycReply(value, id), rejected('invalid_response'));
  assert.throws(() => normalizeKycReply({ ...reply(), evaluationId: 'invalid' }, 'invalid'), rejected('invalid_response'));
});

test('a silent source is bounded and cancelled even when it ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const provider = new KycProvider(async (_input, signal) => {
    signal.addEventListener('abort', () => { cancelled = true; });
    return new Promise<VerificationEvaluation>(() => {});
  }, 100);
  const pending = assert.rejects(provider.evaluate({ evaluationId: id, evidence }), rejected('timeout'));
  t.mock.timers.tick(100);
  await pending;
  assert.equal(cancelled, true);
});

test('source exceptions disclose only the canonical technical failure', async () => {
  const provider = new KycProvider(async () => { throw new Error('secret upstream payload'); }, 100);
  await assert.rejects(provider.evaluate({ evaluationId: id, evidence }), error => {
    assert.ok(error instanceof VerificationProviderFailure);
    assert.equal(error.code, 'unavailable');
    assert.equal(error.message, 'unavailable');
    return true;
  });
});

test('an invalid provider deadline cannot create an unbounded adapter', () => {
  for (const deadline of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new KycProvider(async () => reply(), deadline), /invalid_kyc_deadline/);
});
