import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { acordFieldErrors, readAcordQuoteRequest, writeAcordFailure, writeAcordQuoteResponse } from '../backend/acquisition-risk/src/adapters/inbound/acord-life-quote';
import type { AcordFieldError, QuoteIssued } from '../backend/acquisition-risk/src/adapters/inbound/acord-life-quote';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { validateQuoteRequest } from '../backend/acquisition-risk/src/domain/quote';
import { InMemoryAccess, MemoryStore, PARTNER, protector } from './support/quote-fakes';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../packages/contracts/${path}`, import.meta.url), 'utf8'));
const corpus = read('examples/acord-life-quote.json');
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const requestSchema = ajv.compile(read('schemas/acord-life-quote-request.v1.json'));
const responseSchema = ajv.compile(read('schemas/acord-life-quote-response.v1.json'));
const TRACE = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';

// The whole inbound path a partner message follows: envelope translation, then the domain's field rules.
type Outcome = { request: Record<string, unknown> } | { errors: AcordFieldError[] };
function translate(message: unknown): Outcome {
  const reading = readAcordQuoteRequest(message);
  if (!reading.ok) return { errors: reading.errors };
  const checked = validateQuoteRequest(reading.request, corpus.asOf);
  return checked.ok ? { request: reading.request } : { errors: acordFieldErrors(checked.errors) };
}

for (const item of corpus.cases) {
  test(`ACORD corpus case ${item.name}`, () => {
    assert.equal(requestSchema(item.message), item.schemaValid, JSON.stringify(requestSchema.errors));
    assert.deepEqual(translate(item.message), item.expected);
  });
}

test('the corpus has valid and negative cases, and the schema never accepts a message the translation rejects for its shape', () => {
  const valid = corpus.cases.filter((item: { expected: Outcome }) => 'request' in item.expected);
  const negative = corpus.cases.filter((item: { expected: Outcome }) => 'errors' in item.expected);
  assert.ok(valid.length >= 3 && negative.length >= 10);
  for (const item of negative.filter((n: { schemaValid: boolean }) => n.schemaValid)) {
    // Only business rules beyond the published shape, such as the insurable age, may reject a schema-valid message.
    assert.ok(item.expected.errors.every((error: AcordFieldError) => error.code === 'age_out_of_range'), item.name);
  }
  const codes = new Set(negative.flatMap((item: { expected: { errors: AcordFieldError[] } }) => item.expected.errors.map(error => error.code)));
  for (const code of ['unsupported_version', 'unsupported_transaction', 'unsupported_currency', 'unsupported_product', 'required', 'invalid_type', 'invalid_format']) assert.ok(codes.has(code), code);
});

for (const sample of corpus.responses) {
  test(`ACORD response for a ${sample.name} quote follows its schema and carries the internal quote`, () => {
    const message = writeAcordQuoteResponse(sample as QuoteIssued);
    assert.equal(responseSchema(message), true, JSON.stringify(responseSchema.errors));
    const { quote } = sample;
    assert.equal(message.TXLifeResponse.TransRefGUID, quote.traceId);
    assert.equal(message.TXLifeResponse.TransResult.Replayed, sample.status === 'replayed');
    assert.deepEqual(
      [message.TXLifeResponse.Quote.QuoteNumber, message.TXLifeResponse.Quote.ModalPremiumAmt, message.TXLifeResponse.Quote.FaceAmt, message.TXLifeResponse.Quote.TermMonths, message.TXLifeResponse.Quote.ExpirationDate, message.TXLifeResponse.Quote.RateVersion],
      [quote.quoteId, quote.premiumMonthly, quote.sumInsured, quote.termMonths, quote.validUntil, quote.ruleVersion]
    );
  });
}

test('an ACORD failure follows the response schema and names paths, never the submitted values', () => {
  const rejected = corpus.cases.find((item: { name: string }) => item.name === 'malformed-document');
  const outcome = translate(rejected.message);
  assert.ok('errors' in outcome);
  const message = writeAcordFailure(outcome.errors, TRACE);
  assert.equal(responseSchema(message), true, JSON.stringify(responseSchema.errors));
  assert.ok(!JSON.stringify(message).includes('12AB'));
});

test('the response schema rejects a success without its quote and a failure without reasons', () => {
  const created = writeAcordQuoteResponse(corpus.responses[0] as QuoteIssued);
  const { Quote: _quote, ...withoutQuote } = created.TXLifeResponse;
  assert.equal(responseSchema({ ...created, TXLifeResponse: withoutQuote }), false);
  assert.equal(responseSchema(writeAcordFailure([], TRACE)), false);
  assert.equal(responseSchema({ ...writeAcordFailure([{ field: 'schemaVersion', code: 'unsupported_version' }], TRACE), schemaVersion: '2' }), false);
});

test('a partner ACORD message reaches the real quote use case and comes back as an ACORD quote', async () => {
  const store = new MemoryStore();
  const quotes = new CreateQuote({ access: new InMemoryAccess(), store, clock: { now: () => new Date('2026-10-06T15:00:00Z') }, protector });
  const reading = readAcordQuoteRequest(corpus.cases[0].message);
  assert.ok(reading.ok);
  const result = await quotes.execute({ credential: PARTNER, idempotencyKey: 'acord-1', body: reading.request, traceId: TRACE });
  assert.ok(result.status === 'created');
  const message = writeAcordQuoteResponse(result);
  assert.equal(responseSchema(message), true, JSON.stringify(responseSchema.errors));
  assert.equal(message.TXLifeResponse.Quote.ModalPremiumAmt, 86400);
  assert.equal(store.saved.length, 1);
});
