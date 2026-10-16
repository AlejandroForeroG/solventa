import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { eventContent, isOfferEnvelope, isParametricEnvelope } from '../backend/policy-claims-payments/src/domain/financial';
import { HmacOfferIntegrity } from '../backend/acquisition-risk/src/adapters/outbound/hmac-offer-integrity';
import { HmacFinancialIntegrity } from '../backend/policy-claims-payments/src/adapters/outbound/financial-integrity';

const read = (path: string) => readFileSync(`packages/contracts/${path}`, 'utf8');
const examples = JSON.parse(read('examples/financial.json'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const common = parse(read('openapi/v1/common.yaml'));
ajv.addSchema({ ...common, $id: 'https://solventa.test/v1/common.yaml' });
for (const domain of ['offers', 'policies']) ajv.addSchema({ ...parse(read(`openapi/v1/${domain}.yaml`)), $id: `https://solventa.test/v1/${domain}.yaml` });
const validate = (domain: string, schema: string, body: unknown) => {
  const check = ajv.getSchema(`https://solventa.test/v1/${domain}.yaml#/components/schemas/${schema}`);
  assert.ok(check);
  assert.equal(check(body), true, JSON.stringify(check.errors));
};

test('financial examples match the public schemas and omit principal/provider credentials', () => {
  validate('offers', 'Offer', examples.offer);
  validate('offers', 'Acceptance', examples.acceptance);
  validate('policies', 'Policy', examples.policy);
  for (const body of [examples.offer, examples.acceptance, examples.policy]) {
    assert.equal('subjectToken' in body, false);
    assert.equal('clientId' in body, false);
  }
});

test('issue contract rejects free amounts, approval and destinations', () => {
  const check = ajv.getSchema('https://solventa.test/v1/policies.yaml#/components/schemas/IssueRequest');
  assert.ok(check);
  assert.equal(check({ documentHash: 'a'.repeat(64) }), true);
  for (const extra of [{ amount: '1.0000' }, { approved: true }, { beneficiary: 'another-client' }]) assert.equal(check({ documentHash: 'a'.repeat(64), ...extra }), false);
});

test('signed event schema agrees with both consumer payload shapes without authorizing example signatures', () => {
  const check = ajv.compile(JSON.parse(read('schemas/financial-event.v1.json')));
  assert.equal(check(examples.event), true, JSON.stringify(check.errors));
  assert.equal(isOfferEnvelope(examples.event, 'local'), true);
  const parametric = { ...examples.event, eventType: 'flight.delay_verified', payload: { policyId: examples.policy.policyId, flightReference: examples.offer.offerId, delayMinutes: 180 } };
  assert.equal(check(parametric), true, JSON.stringify(check.errors));
  assert.equal(isParametricEnvelope(parametric, 'local'), true);
  for (const invalid of [{ ...examples.event, environment: 'prod' }, { ...examples.event, synthetic: false }, { ...examples.event, unexpected: 'personal data' }, { ...parametric, payload: { ...parametric.payload, payoutAmount: '1.0000' } }]) assert.equal(check(invalid), false);
});

test('Acquisition signatures are verified by the actual Policy adapter and bind money and environment', async () => {
  const key = 'synthetic-local-' + 'f'.repeat(32);
  const producer = new HmacOfferIntegrity(key);
  const consumer = new HmacFinancialIntegrity(key);
  const { signature: _exampleSignature, ...unsigned } = examples.event;
  const signed = await producer.sign(unsigned);
  assert.ok(isOfferEnvelope(signed, 'local'));
  assert.equal(await consumer.verify(eventContent(signed), signed.signature), true);
  const changed = { ...signed, payload: { ...signed.payload, premium: '1.0000' } };
  assert.equal(await consumer.verify(eventContent(changed), signed.signature), false);
  assert.equal(await new HmacFinancialIntegrity('another-synthetic-environment-secret-key').verify(eventContent(signed), signed.signature), false);
  assert.equal(isOfferEnvelope({ ...signed, environment: 'dev' }, 'local'), false);
});
