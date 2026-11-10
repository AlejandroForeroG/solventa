import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv from 'ajv';
import { searchSyntheticAssistance, syntheticAssistanceDirectory } from '../backend/policy-claims-payments/src/adapters/outbound/synthetic-assistance-directory';

const manual = { kind: 'manual', query: '  bOgOtA  ' } as const;

test('manual search accepts a city or fixture address without device coordinates', () => {
  const city = searchSyntheticAssistance(manual);
  assert.equal(city.status, 'ok');
  if (city.status !== 'ok') return;
  assert.equal(city.simulated, true);
  assert.deepEqual(city.providers.map(provider => provider.id), ['demo-bog-expert', 'demo-bog-workshop']);
  assert.ok(city.providers.every(provider => provider.phone && provider.hours && !('coordinates' in provider)));
  const address = searchSyntheticAssistance({ kind: 'manual', query: 'Calle de prueba 10, Bogotá' });
  assert.equal(address.status, 'ok');
  if (address.status === 'ok') assert.deepEqual(address.providers.map(provider => provider.id), ['demo-bog-workshop']);
});

test('nearby search orders within the radius and returns an empty result outside coverage', () => {
  const local = searchSyntheticAssistance({ kind: 'nearby', coordinates: { latitude: 4.648, longitude: -74.098 } });
  assert.equal(local.status, 'ok');
  if (local.status === 'ok') assert.deepEqual(local.providers.map(provider => provider.id), ['demo-bog-workshop', 'demo-bog-expert']);
  assert.deepEqual(searchSyntheticAssistance({ kind: 'nearby', coordinates: { latitude: 0, longitude: 0 } }),
    { status: 'ok', simulated: true, providers: [] });
  assert.deepEqual(searchSyntheticAssistance({ kind: 'nearby', coordinates: { latitude: 100, longitude: 0 } }),
    { status: 'invalid_input' });
});

test('the synthetic catalog matches its schema and invalid provider payloads fail closed', () => {
  const schema = JSON.parse(readFileSync('packages/contracts/schemas/synthetic-assistance-directory.v1.json', 'utf8'));
  const validate = new Ajv().compile(schema);
  assert.equal(validate(syntheticAssistanceDirectory), true, JSON.stringify(validate.errors));
  const [provider] = syntheticAssistanceDirectory.providers;
  const invalid = [
    { ...syntheticAssistanceDirectory, simulated: false },
    { ...syntheticAssistanceDirectory, formatVersion: 'unknown' },
    { ...syntheticAssistanceDirectory, providers: [{ ...provider, coordinates: { latitude: 100, longitude: 0 } }] },
    { ...syntheticAssistanceDirectory, providers: [{ ...provider, phone: '+573001234567' }] },
  ];
  for (const payload of invalid) {
    assert.equal(validate(payload), false);
    assert.deepEqual(searchSyntheticAssistance(manual, payload), { status: 'unavailable' });
  }
  const duplicate = { ...syntheticAssistanceDirectory, providers: [provider, provider] };
  assert.deepEqual(searchSyntheticAssistance(manual, duplicate), { status: 'unavailable' });
  assert.deepEqual(searchSyntheticAssistance({ kind: 'manual', query: 'Una ciudad no incluida' }),
    { status: 'ok', simulated: true, providers: [] });
});
