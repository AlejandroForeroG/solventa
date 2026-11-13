import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contractSchema } from './support/openapi-schemas';

const corpus = JSON.parse(readFileSync(new URL('../packages/contracts/examples/partner-offers.json', import.meta.url), 'utf8'));
const request = contractSchema('partner-offers', 'PartnerOfferRequest');
const offer = contractSchema('partner-offers', 'PartnerOffer');

test('every valid corpus request passes the partner offer request schema', () => {
  for (const { name, body } of corpus.request.valid) assert.equal(request(body).valid, true, name);
});

test('every negative corpus request fails the schema: a customer identifier, a bad authorization or a bad quote never validates', () => {
  for (const { name, body } of corpus.request.invalid) assert.equal(request(body).valid, false, name);
});

test('the corpus responses pass the offer schema and a preliminary offer is never contractable', () => {
  for (const [name, example] of Object.entries(corpus.responses) as [string, { status: string; contractable: boolean }][]) {
    const checked = offer(example);
    assert.equal(checked.valid, true, `${name}: ${checked.errors}`);
    assert.equal(example.contractable, example.status === 'definitive', name);
  }
  for (const [mutation, change] of [['unknown field', { clientId: '30000000-0000-4000-8000-000000000001' }], ['missing explanation', { explanation: undefined }],
    ['wrong status', { status: 'accepted' }], ['non decimal premium', { premium: 86400 }]] as const) {
    assert.equal(offer({ ...corpus.responses.definitive, ...change }).valid, false, mutation);
  }
});
