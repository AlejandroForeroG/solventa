import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(path, 'utf8');
const quotes = parse(read('packages/contracts/openapi/v1/quotes.yaml'));
const common = parse(read('packages/contracts/openapi/v1/common.yaml'));
const examples = JSON.parse(read('packages/contracts/examples/quotes.json'));

// The specs are registered under their folder URL so `./common.yaml#...` references resolve.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ ...common, $id: 'https://solventa.test/v1/common.yaml' });
ajv.addSchema({ ...quotes, $id: 'https://solventa.test/v1/quotes.yaml' });
const schema = (name: string) => {
  const check = ajv.getSchema(`https://solventa.test/v1/quotes.yaml#/components/schemas/${name}`);
  assert.ok(check, `schema ${name}`);
  return check;
};
const fieldsOf = (errors: { instancePath: string; keyword: string; params: Record<string, unknown> }[]) => new Set(errors.map(e => {
  const base = e.instancePath.split('/').filter(Boolean);
  if (e.keyword === 'required') base.push(String(e.params.missingProperty));
  return base.join('.');
}));

// Reference rule, only to prove the examples are consistent; the service's rule is tested in quotes.test.ts.
function ageOn(birthDate: string, asOf: string) {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ay, am, ad] = asOf.split('-').map(Number);
  return ay - by - (am < bm || (am === bm && ad < bd) ? 1 : 0);
}
function premium(amount: number, age: number) {
  const band = examples.rule.bands.find((b: { minAge: number; maxAge: number }) => age >= b.minAge && age <= b.maxAge);
  assert.ok(band, `no band for age ${age}`);
  return Math.floor((amount * band.ppm + 500000) / 1000000);
}

test('the contract declares both entries, the shared headers and the status codes of the quote', () => {
  assert.equal(quotes.servers[0].url, '/api/v1');
  const key = quotes.components.parameters.IdempotencyKey;
  assert.equal(key.required, true);
  assert.equal(key.in, 'header');
  const partner = quotes.paths['/quotes'].post;
  const user = quotes.paths['/me/quotes'].post;
  assert.deepEqual(partner.security, [{ PartnerBearer: [] }]);
  assert.deepEqual(user.security, [{ WebSession: [] }, { LocalWebSession: [] }]);
  assert.equal(quotes.components.securitySchemes.PartnerBearer.bearerFormat, 'JWT');
  for (const operation of [partner, user]) {
    for (const code of ['200', '201', '400', '401', '403', '409', '503']) assert.ok(operation.responses[code], `missing response ${code}`);
    assert.deepEqual(operation.requestBody, partner.requestBody, 'both entries accept the same request');
    assert.deepEqual(operation.responses['201'], partner.responses['201'], 'both entries return the same quote');
  }
  assert.notDeepEqual(partner.responses['401'], user.responses['401'], 'only the partner entry sends a Bearer challenge');
  assert.ok(quotes.components.responses.PartnerUnauthorized.headers['WWW-Authenticate']);
  assert.equal(quotes.components.responses.UserUnauthorized.headers['WWW-Authenticate'], undefined);
});

test('the provisional rule covers every insurable age without gaps or overlaps', () => {
  const bands = examples.rule.bands;
  assert.equal(bands[0].minAge, 18);
  assert.equal(bands.at(-1).maxAge, 70);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].minAge, bands[i - 1].maxAge + 1);
});

for (const item of examples.cases) {
  test(`case ${item.name}`, () => {
    const check = schema('QuoteRequest');
    const valid = check(item.request);
    assert.equal(valid, item.schemaValid, `schema validity: ${JSON.stringify(check.errors)}`);
    if (!valid) {
      const failing = fieldsOf(check.errors ?? []);
      for (const expected of item.expected.errors) assert.ok(failing.has(expected.field), `expected ${expected.field} among ${[...failing]}`);
      return;
    }
    const age = ageOn(item.request.customer.birthDate, examples.asOf);
    const insurable = age >= 18 && age <= 70;
    if (item.expected.status === 201) {
      assert.ok(insurable);
      assert.equal(age, item.expected.age);
      assert.equal(premium(item.request.credit.amount, age), item.expected.premiumMonthly);
    } else {
      assert.equal(insurable, false);
      assert.deepEqual(item.expected.errors[0].params, { age, min: 18, max: 70 });
    }
  });
}

test('every response example satisfies its schema', () => {
  assert.ok(schema('Quote')(examples.responses.quote), JSON.stringify(schema('Quote').errors));
  assert.ok(schema('ValidationError')(examples.responses.validationError), JSON.stringify(schema('ValidationError').errors));
  for (const body of Object.values(examples.responses.accessErrors)) assert.ok(schema('AccessError')(body), JSON.stringify(schema('AccessError').errors));
  const base = examples.cases[0];
  assert.equal(examples.responses.quote.premiumMonthly, base.expected.premiumMonthly);
  assert.equal(examples.responses.quote.sumInsured, base.request.credit.amount);
});

test('the 409 body is the shared Error shape of the version', () => {
  const check = ajv.compile({ $ref: 'https://solventa.test/v1/common.yaml#/components/schemas/Error' });
  const body = quotes.components.responses.Conflict.content['application/json'].example;
  assert.ok(check(body), JSON.stringify(check.errors));
});

test('responses never echo personal data from the request', () => {
  const text = JSON.stringify(examples.responses);
  for (const item of examples.cases) {
    assert.ok(!text.includes(item.request.customer.documentNumber ?? '\u0000'));
    assert.ok(!text.includes(item.request.customer.fullName ?? '\u0000'));
    assert.ok(!text.includes(item.request.customer.birthDate ?? '\u0000'));
  }
});

test('access errors carry only the canonical code and the trace id', () => {
  const check = schema('AccessError');
  const { unauthorized, forbidden, unavailable } = examples.responses.accessErrors;
  assert.deepEqual([unauthorized.error, forbidden.error, unavailable.error], ['unauthorized', 'forbidden', 'access_unavailable']);
  assert.equal(check({ ...unauthorized, reason: 'revoked' }), false, 'no provider or cause detail');
  assert.equal(check({ ...unauthorized, message: 'Token expired for partner x' }), false);
  assert.equal(check({ ...unauthorized, error: 'scope_missing' }), false, 'only canonical codes');
  assert.equal(check({ error: 'unauthorized', traceId: 'not-a-uuid' }), false);
});

test('responses that break the contract are rejected', () => {
  const quote = schema('Quote');
  const good = examples.responses.quote;
  assert.equal(quote({ ...good, currency: 'USD' }), false, 'the currency is always COP');
  assert.equal(quote({ ...good, quoteId: 'COT-26-1' }), false);
  assert.equal(quote({ ...good, basis: 'open_finance' }), false);
  assert.equal(quote({ ...good, premiumMonthly: 86400.5 }), false);
  assert.equal(quote({ ...good, validUntil: 'tomorrow' }), false);
  assert.equal(quote({ ...good, traceId: '7f3c2a9e1b4d4c8aa0d1e2f3a4b5c6d7' }), false, 'the trace id is a UUID');
  const { ruleVersion: _ruleVersion, ...withoutRule } = good;
  assert.equal(quote(withoutRule), false);
  assert.equal(quote({ ...good, extra: 1 }), false);
});

test('requests that break the contract are rejected', () => {
  const request = schema('QuoteRequest');
  const good = examples.cases[0].request;
  assert.equal(request({ ...good, extra: true }), false);
  assert.equal(request({ ...good, customer: { ...good.customer, documentType: 'CE' } }), false);
  assert.equal(request({ ...good, customer: { ...good.customer, birthDate: '14/03/1992' } }), false);
  assert.equal(request({ ...good, credit: { ...good.credit, amount: 1.5 } }), false);
  assert.equal(request({ ...good, credit: { ...good.credit, amount: '320000000' } }), false);
});
