import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { EstimateQuote } from '../backend/acquisition-risk/src/application/estimate-quote';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import { createHttp } from '../backend/acquisition-risk/src/adapters/inbound/http';
import { InMemoryAccess, MemoryStore, protector } from './support/quote-fakes';
import worker from '../apps/web/worker/index';

const useCase = new EstimateQuote();
const input = { ageYears: 34, amount: 320000000, termMonths: 180 };
const traceId = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';
const spec = parse(readFileSync('packages/contracts/openapi/v1/quotes.yaml', 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: 'https://solventa.test/quotes.yaml' });
const schema = (name: string) => ajv.compile({ $ref: `https://solventa.test/quotes.yaml#/components/schemas/${name}` });

test('anonymous estimates use the saved-quote rating rule at every band boundary', () => {
  const operation = spec.paths['/quote-estimates'].post;
  const example = operation.requestBody.content['application/json'].example;
  assert.ok(schema('EstimateRequest')(example));
  const expected = operation.responses['200'].content['application/json'].example;
  assert.ok(schema('Estimate')(expected));
  const actual = useCase.execute(example);
  assert.ok(actual.status === 'estimated');
  assert.deepEqual({ ...actual.estimate, traceId: expected.traceId }, expected);
  for (const [ageYears, premiumMonthly] of [[18, 70400], [30, 70400], [31, 86400], [40, 86400], [41, 128000], [50, 128000], [51, 208000], [60, 208000], [61, 320000], [70, 320000]]) {
    const result = useCase.execute({ ...input, ageYears });
    assert.equal(result.status, 'estimated');
    if (result.status === 'estimated') assert.equal(result.estimate.premiumMonthly, premiumMonthly);
  }
  const result = useCase.execute({ ...input, amount: Number.MAX_SAFE_INTEGER });
  assert.ok(result.status === 'estimated' && Number.isSafeInteger(result.estimate.premiumMonthly));
});

test('the public calculator accepts only safe integer inputs in the advertised ranges', () => {
  for (const body of [null, [], {}, { ...input, ageYears: 17 }, { ...input, ageYears: 71 }, { ...input, ageYears: '34' }, { ...input, amount: 0 }, { ...input, amount: 1.1 }, { ...input, amount: 2 ** 53 }, { ...input, termMonths: 11 }, { ...input, termMonths: 241 }, { ...input, customer: 'private' }]) {
    assert.equal(useCase.execute(body).status, 'invalid', JSON.stringify(body));
    assert.equal(schema('EstimateRequest')(body), false, 'contract agrees with validation');
  }
  for (const body of [{ ageYears: 18, amount: 1, termMonths: 12 }, { ageYears: 70, amount: Number.MAX_SAFE_INTEGER, termMonths: 240 }]) {
    assert.equal(useCase.execute(body).status, 'estimated');
    assert.equal(schema('EstimateRequest')(body), true);
  }
});

function setup() {
  const access = new InMemoryAccess();
  const store = new MemoryStore();
  const quotes = new CreateQuote({ access, store, clock: { now: () => new Date('2026-10-15T15:00:00Z') }, protector });
  const app = createHttp({ quotes, estimates: useCase });
  return { app, access, store };
}
function request(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request('https://web.example/api/v1/quote-estimates', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': traceId, ...headers }, body, ...(typeof body !== 'string' ? { duplex: 'half' } : {}) } as RequestInit);
}

test('public routing calculates with no credential, Identity call or stored quote and satisfies OpenAPI', async () => {
  const { app, access, store } = setup();
  let calls = 0;
  const env = { ACQUISITION: { fetch: async (req: Request) => { calls++; return app.request(req); } } } as never;
  const response = await worker.fetch(request(JSON.stringify(input)), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(schema('Estimate')(body));
  assert.equal(body.premiumMonthly, 86400);
  assert.equal(body.traceId, traceId);
  assert.equal(body.quoteId, undefined);
  assert.equal(body.validUntil, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-trace-id'), traceId);
  assert.equal(calls, 1);
  assert.equal(access.calls.length, 0);
  assert.equal(store.saved.length, 0);
  assert.deepEqual(spec.paths['/quote-estimates'].post.security, []);
  assert.equal(spec.info.version, '1.2.0');
});

test('malformed and oversized public bodies are rejected with redacted contractual errors', async () => {
  const { app } = setup();
  for (const raw of ['not json', '{}', '[]', JSON.stringify({ ...input, 'private@example.invalid': 'discard' }), 'x'.repeat(1025)]) {
    const response = await app.request(request(raw));
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes('private@example.invalid'));
    assert.ok(schema('EstimateValidationError')(JSON.parse(text)));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await app.request(request(JSON.stringify(input), { 'content-type': 'text/plain' }))).status, 400);
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(512)); }, cancel() { cancelled = true; } });
  assert.equal((await app.request(request(stream))).status, 400);
  assert.ok(pulls < 6 && cancelled, 'an unbounded body is cancelled early');
});

test('public estimates do not unlock saved quotes or create Identity credentials', async () => {
  const { app, access, store } = setup();
  await app.request(request(JSON.stringify(input)));
  for (const path of ['/api/v1/quotes', '/api/v1/me/quotes']) {
    const response = await app.request(`https://web.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, { APP_ENV: 'dev' } as never);
    assert.equal(response.status, 401);
  }
  assert.equal(access.calls.length, 0);
  assert.equal(store.saved.length, 0);
});
