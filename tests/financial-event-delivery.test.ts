import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { FinancialEventDelivery } from '../backend/acquisition-risk/src/adapters/outbound/financial-event-delivery';
import type { PolicyImportService } from '../backend/acquisition-risk/src/adapters/outbound/financial-event-delivery';
import { acceptedOffer } from './financial-fixtures';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}
function fixture(policy?: PolicyImportService, deadline = 750) {
  const background: Promise<unknown>[] = [];
  const reports: Parameters<ConstructorParameters<typeof FinancialEventDelivery>[0]['report']>[0][] = [];
  const reported = deferred<typeof reports[number]>();
  const delivery = new FinancialEventDelivery({ policy, waitUntil: work => { background.push(work); }, report: result => { reports.push(result); reported.resolve(result); }, importDeadlineMs: deadline });
  return { delivery, background, reports, reported };
}

test('a committed event can reach Policy while independent Queue publication is still pending', async () => {
  const event = await acceptedOffer(), imported = deferred<unknown>(), receivedEvent = deferred<unknown>();
  let received: unknown;
  const f = fixture({ acceptOfferV1: async input => { received = input; receivedEvent.resolve(input); return imported.promise; } });
  const sent = f.delivery.send(event);
  await receivedEvent.promise;
  assert.deepEqual(received, event);
  assert.deepEqual(f.reports, [], 'a pending RPC has not established import');
  imported.resolve({ status: 'ok', policy: { policyId: randomUUID(), offerId: event.payload.offerId, offerVersion: event.payload.offerVersion } });
  await sent;
  await Promise.all(f.background);
  assert.equal(f.reports[0].outcome, 'imported');
  assert.equal(f.reports[0].eventId, event.eventId);
});

test('an absent optional Policy binding reports no false import receipt', async () => {
  const f = fixture(undefined);
  await f.delivery.send(await acceptedOffer()); await Promise.all(f.background);
  assert.deepEqual(f.reports, []);
});

test('an unavailable RPC reports a canonical outcome without exposing the provider error', async () => {
  const f = fixture({ acceptOfferV1: async () => { throw new Error('synthetic-private-marker'); } });
  const event = await acceptedOffer();
  await f.delivery.send(event); await Promise.all(f.background);
  assert.equal(f.reports[0].outcome, 'unavailable');
  assert.equal(f.reports[0].traceId, event.correlationId);
  assert.ok(Number.isFinite(f.reports[0].durationMs));
  assert.deepEqual(Object.keys(f.reports[0]).sort(), ['durationMs', 'eventId', 'outcome', 'traceId']);
  assert.equal(JSON.stringify(f.reports).includes('synthetic-private-marker'), false);
});

test('an RPC deadline preserves the actual in-flight promise until its eventual completion without retrying it', async () => {
  const call = deferred<unknown>(); let calls = 0;
  const f = fixture({ acceptOfferV1: async () => { calls++; return call.promise; } }, 1);
  await f.delivery.send(await acceptedOffer());
  assert.equal((await f.reported.promise).outcome, 'unavailable');
  assert.equal(calls, 1);
  let completed = false;
  const retained = Promise.all(f.background).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false, 'the actual RPC remains registered after the deadline');
  call.resolve({ status: 'unavailable' }); await retained;
  assert.equal(completed, true); assert.equal(calls, 1);
  assert.equal(f.reports.length, 1, 'a late receipt never overwrites the observed timeout');
});

test('only a matching owner receipt establishes an imported event', async () => {
  const event = await acceptedOffer();
  for (const result of [null, { status: 'ok' }, { status: 'ok', policy: { policyId: 'invalid', offerId: event.payload.offerId, offerVersion: 1 } },
    { status: 'ok', policy: { policyId: randomUUID(), offerId: randomUUID(), offerVersion: 1 } },
    { status: 'ok', policy: { policyId: randomUUID(), offerId: event.payload.offerId, offerVersion: 2 } }, { status: 'unavailable' }]) {
    const f = fixture({ acceptOfferV1: async () => result });
    await f.delivery.send(event); await Promise.all(f.background);
    assert.equal(f.reports[0].outcome, 'unavailable');
  }
  const denied = fixture({ acceptOfferV1: async () => ({ status: 'denied', error: 'invalid_event' }) });
  await denied.delivery.send(event); await Promise.all(denied.background);
  assert.equal(denied.reports[0].outcome, 'rejected');
});

test('invalid import deadlines cannot start a delivery', () => {
  for (const importDeadlineMs of [0, -1, 1.5, 1001, NaN]) {
    assert.throws(() => new FinancialEventDelivery({ waitUntil() {}, report() {}, importDeadlineMs }), /financial_import_deadline_invalid/);
  }
});
