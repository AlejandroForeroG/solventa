import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { MockParametricEventProvider, providerEventContent } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';
import type { ProviderEventV1 } from '../backend/policy-claims-payments/src/adapters/outbound/mock-parametric-provider';
import { isOfferEnvelope } from '../backend/policy-claims-payments/src/domain/financial';
import { acceptedOffer, financialIntegrity } from './financial-fixtures';

type Case = { name: string; sign: boolean; schemaValid: boolean; message: Record<string, unknown>; expected: { status: 'verified'; occurrence: unknown } | { status: 'invalid' } };
const read = (path: string) => JSON.parse(readFileSync(new URL(`../packages/contracts/${path}`, import.meta.url), 'utf8'));
const corpus: { environment: 'local'; cases: Case[] } = read('examples/parametric-provider-events.json');
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const schema = ajv.compile(read('schemas/parametric-provider-event.v1.json'));
const provider = new MockParametricEventProvider(financialIntegrity, corpus.environment);

async function sealed(item: Case): Promise<Record<string, unknown>> {
  if (!item.sign) return item.message;
  // The content function reads the fields it signs, so a malformed message is sealed over whatever it carries.
  const content = (() => { try { return providerEventContent(item.message as Omit<ProviderEventV1, 'signature'>); } catch { return JSON.stringify(item.message); } })();
  return { ...item.message, signature: await financialIntegrity.digest(content) };
}

for (const item of corpus.cases) {
  test(`parametric provider corpus case ${item.name}`, async () => {
    const message = await sealed(item);
    assert.equal(schema(message), item.schemaValid, JSON.stringify(schema.errors));
    const received = await provider.receive(message);
    assert.equal(received.status, item.expected.status);
    if (item.expected.status === 'verified') assert.deepEqual(received.status === 'verified' && received.occurrence, item.expected.occurrence);
  });
}

test('the corpus has valid and negative cases, and the adapter never accepts a message the schema rejects', async () => {
  assert.ok(corpus.cases.filter(item => item.expected.status === 'verified').length >= 4);
  assert.ok(corpus.cases.filter(item => item.expected.status === 'invalid').length >= 12);
  for (const item of corpus.cases.filter(candidate => !candidate.schemaValid)) assert.equal((await provider.receive(await sealed(item))).status, 'invalid', item.name);
});

test('the accepted-offer event schema and the Policy domain agree on the weather coverage', async () => {
  const check = ajv.compile(read('schemas/financial-event.v1.json'));
  const event = await acceptedOffer('weather_event');
  assert.equal(check(event), true, JSON.stringify(check.errors));
  assert.equal(isOfferEnvelope(event, 'local'), true);
  const coverage = event.payload.coverage;
  for (const changed of [{ ...coverage, threshold: 49 }, { ...coverage, unit: 'cm' }, { ...coverage, parameter: 'wind' }, { ...coverage, stationId: 'station-7' }, { ...coverage, payoutAmount: '1.0000' }]) {
    const altered = { ...event, payload: { ...event.payload, coverage: changed } };
    assert.equal(check(altered), false);
    assert.equal(isOfferEnvelope(altered, 'local'), false);
  }
  assert.equal(isOfferEnvelope({ ...event, payload: { ...event.payload, ruleVersion: 'academic-flight-1' } }, 'local'), false, 'a weather policy carries its own rule version');
  assert.equal(isOfferEnvelope({ ...event, payload: { ...event.payload, product: 'flight_delay' } }, 'local'), false, 'product and coverage must agree');
});

test('a signature made for one environment, event or value never verifies another', async () => {
  const [flight] = corpus.cases;
  const message = await sealed(flight) as ProviderEventV1;
  assert.equal((await provider.receive(message)).status, 'verified');
  assert.equal((await new MockParametricEventProvider(financialIntegrity, 'staging').receive(message)).status, 'invalid');
  assert.equal((await provider.receive({ ...message, providerEventId: '40000000-0000-4000-8000-0000000000ff' })).status, 'invalid');
  assert.equal((await provider.receive({ ...message, reading: { ...message.reading, delayMinutes: 181 } })).status, 'invalid');
});
