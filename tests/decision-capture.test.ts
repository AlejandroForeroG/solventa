import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
const minimum = {
  schemaVersion: 1,
  contractVersion: 'v1',
  correlationId: '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47',
  inputs: { product: 'vida_hipotecario', ageYears: 34, amount: 320000000, termMonths: 180 },
  sources: [],
  consent: { status: 'not_required' },
  rule: { id: 'quote-rating', version: '2026.1' },
  outcome: 'issued',
};
const profiled = {
  ...minimum,
  sources: [{ source: 'open_finance', capturedAt: '2026-10-06T15:04:05Z', quality: 'high', degraded: false }],
  consent: { status: 'verified', id: 'a1c3e5f7-0000-4000-8000-000000000001', version: 1 },
  model: { id: 'risk-profile', version: '3.2' },
};

test('captures with minimum data and with a profile are valid', () => {
  assert.equal(validate(minimum), true);
  assert.equal(validate(profiled), true);
});

test('new optional fields do not break a v1 capture', () => {
  assert.equal(validate({ ...minimum, futureField: { any: 'value' } }), true);
});

test('captures missing required history are rejected', () => {
  for (const key of ['schemaVersion', 'contractVersion', 'correlationId', 'inputs', 'sources', 'consent', 'rule', 'outcome']) {
    const { [key]: _removed, ...incomplete } = minimum as Record<string, unknown>;
    assert.equal(validate(incomplete), false, key);
  }
});

test('captures with invalid versions or identifiers are rejected', () => {
  assert.equal(validate({ ...minimum, schemaVersion: 2 }), false);
  assert.equal(validate({ ...minimum, contractVersion: 'v0' }), false);
  assert.equal(validate({ ...minimum, contractVersion: '1' }), false);
  assert.equal(validate({ ...minimum, correlationId: '7f3c2a9e' }), false);
  assert.equal(validate({ ...minimum, rule: { id: 'quote-rating' } }), false);
  assert.equal(validate({ ...minimum, outcome: '' }), false);
});

test('a verified consent must identify the consent and its version', () => {
  assert.equal(validate({ ...minimum, consent: { status: 'verified' } }), false);
  assert.equal(validate({ ...minimum, consent: { status: 'verified', id: 'a1c3e5f7-0000-4000-8000-000000000001' } }), false);
  assert.equal(validate({ ...minimum, consent: { status: 'unknown' } }), false);
});

test('every consulted source records when it was captured', () => {
  assert.equal(validate({ ...minimum, sources: [{ source: 'open_finance' }] }), false);
  assert.equal(validate({ ...minimum, sources: [{ source: 'open_finance', capturedAt: 'yesterday' }] }), false);
});
