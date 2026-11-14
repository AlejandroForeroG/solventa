import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Reports } from '../backend/policy-claims-payments/src/application/reports';
import { reviewDelivery } from '../backend/policy-claims-payments/src/adapters/outbound/report-destination-contract';
import { assertReportablePeriod, buildReportCsv, currentPeriod, groupRows, parseReportCsv, periodBounds, ReportError, reportHeader, type ReportDelivery, type ReportDestinationId, type ReportFacts } from '../backend/policy-claims-payments/src/domain/report';
import { Sha256ReportDigest } from '../backend/policy-claims-payments/src/adapters/outbound/sha256-report-digest';
import { TimerDeadline } from '../backend/policy-claims-payments/src/adapters/outbound/timer-deadline';
import { deliveryFor, emptyFacts, ids, syntheticFacts } from './support/report-fixtures';
import { MemoryDestination, MemoryReportStore } from './support/report-fakes';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../packages/contracts/${path}`, import.meta.url), 'utf8'));
type Corpus = { cases: { name: string; destination: ReportDestinationId; fault?: 'timeout'; expected: { outcome: string; code?: string; afterLookup?: string }; message: unknown }[] };
const corpora: Record<ReportDestinationId, Corpus> = { regulator: read('examples/report-deliveries-regulator.json'), reinsurer: read('examples/report-deliveries-reinsurer.json') };
const now = new Date('2026-11-30T20:00:00.000Z');
// The use cases run on the real clock because the authorization lease is real; periods are derived from it.
const period = currentPeriod(new Date());
const nextPeriod = (value: string) => { const [year, month] = value.split('-').map(Number); return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`; };
const actor = () => ({ clientId: ids.operator, traceId: '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47', expiresAt: new Date(Date.now() + 5000).toISOString() });
function service(facts: ReportFacts = syntheticFacts(), deadlineMs = 25) {
  const store = new MemoryReportStore(facts);
  const destinations = { regulator: new MemoryDestination('regulator'), reinsurer: new MemoryDestination('reinsurer') };
  return { store, destinations, reports: new Reports(store, new Sha256ReportDigest(), destinations, { now: () => new Date() }, new TimerDeadline(), deadlineMs) };
}

test('a period is a Bogotá calendar month and cannot be in the future', () => {
  assert.deepEqual(periodBounds('2026-11'), { start: '2026-11-01T05:00:00.000Z', end: '2026-12-01T05:00:00.000Z' });
  assert.deepEqual(periodBounds('2026-12'), { start: '2026-12-01T05:00:00.000Z', end: '2027-01-01T05:00:00.000Z' });
  for (const period of ['2026-13', '2026-00', '26-11', '2026-1', '1999-12', '2026-11-01', '']) assert.throws(() => periodBounds(period), ReportError);
  // 21:00 on the last day in Bogotá is already the next UTC month, but still the same Bogotá month.
  assert.equal(currentPeriod(new Date('2026-12-01T02:00:00.000Z')), '2026-11');
  assert.equal(currentPeriod(new Date('2026-12-01T05:00:00.000Z')), '2026-12');
  assert.throws(() => assertReportablePeriod('2026-12', now), /period_in_future/);
  assert.doesNotThrow(() => assertReportablePeriod('2026-11', now));
});

test('totals are exact decimal sums and an unestimated claim adds nothing to the amount', () => {
  const groups = groupRows(syntheticFacts());
  const find = (group: string) => groups.find(candidate => candidate.group === group);
  assert.deepEqual(find('policy_issued'), { group: 'policy_issued', currency: 'COP', count: 2, amount: '2230000.7500' });
  assert.deepEqual(find('claim:paid'), { group: 'claim:paid', currency: 'COP', count: 1, amount: '0.0000' });
  assert.deepEqual(find('payment:premium:refunded'), { group: 'payment:premium:refunded', currency: 'COP', count: 1, amount: '410000.0001' });
  assert.throws(() => groupRows({ ...syntheticFacts(), payments: [{ ...syntheticFacts().payments[0], amount: '1.5' }] }), ReportError);
});

test('each destination gets its own format: totals only for the regulator, one row per claim and payment for the reinsurer', () => {
  const regulator = buildReportCsv('regulator', syntheticFacts());
  const reinsurer = buildReportCsv('reinsurer', syntheticFacts());
  assert.equal(regulator.split('\n')[0], reportHeader('regulator'));
  assert.equal(reinsurer.split('\n')[0], reportHeader('reinsurer'));
  assert.match(regulator, /\nclaim_total,,,,paid,,,,,,COP,1,0\.0000\n/);
  assert.equal(regulator.includes(ids.claim(1)), false); assert.equal(regulator.includes(ids.payment(1)), false);
  assert.match(reinsurer, new RegExp(`\\nclaim,${ids.policy(1)},${ids.claim(1)},SIN-2026-00001,,,,in_review,`));
  assert.match(reinsurer, new RegExp(`payment,${ids.policy(1)},,,${ids.payment(1)},,premium,confirmed,.*MOCK-${ids.payment(1)},COP,1250000\\.5000`));
});

test('a report carries no identity, biometric or contact data: only identifiers, enums, instants and decimals', () => {
  for (const destination of ['regulator', 'reinsurer'] as const) {
    const csv = buildReportCsv(destination, syntheticFacts());
    assert.equal(/subject|client|email|document|phone|name/i.test(reportHeader(destination)), false);
    for (const cell of csv.split('\n').slice(1).flatMap(row => row.split(',')).filter(Boolean)) assert.match(cell, /^[A-Za-z0-9_.:\-]+$/);
  }
});

test('the artifact is reproducible and independent of the order the rows were read in', () => {
  const facts = syntheticFacts();
  const shuffled: ReportFacts = { ...facts, policies: [...facts.policies].reverse(), claims: [...facts.claims].reverse(), payments: [...facts.payments].reverse() };
  for (const destination of ['regulator', 'reinsurer'] as const) assert.equal(buildReportCsv(destination, shuffled), buildReportCsv(destination, facts));
});

test('a period without data is a valid artifact with a header and zero records', async () => {
  const { reports, store } = service(emptyFacts());
  for (const destination of ['regulator', 'reinsurer'] as const) {
    const { report, created } = await reports.generate({ period, destination }, actor());
    assert.equal(created, true); assert.equal(report.manifest.rowCount, 0); assert.deepEqual(report.manifest.totals, []); assert.deepEqual(report.manifest.records, {});
    const csv = (await reports.download(report.id, 'csv', actor()) as { body: string }).body;
    assert.equal(csv, reportHeader(destination) + '\n');
  }
  assert.equal(store.revisions.length, 2);
});

test('the manifest binds period, destination, format, revision and hash, and reconciles with the rows', async () => {
  const { reports } = service();
  const { report } = await reports.generate({ period, destination: 'reinsurer' }, actor());
  assert.equal(report.manifest.formatVersion, 'reinsurer-bordereau.v1'); assert.equal(report.manifest.ruleVersion, 'academic-report-1');
  assert.equal(report.manifest.period, period); assert.equal(report.manifest.revision, 1); assert.equal(report.manifest.synthetic, true);
  const csv = (await reports.download(report.id, 'csv', actor()) as { body: string; contentHash: string });
  assert.equal(csv.contentHash, report.contentHash); assert.equal(report.manifest.contentHash, report.contentHash);
  const parsed = parseReportCsv('reinsurer', csv.body);
  assert.ok(typeof parsed !== 'string'); assert.equal(parsed.rowCount, report.manifest.rowCount); assert.deepEqual(parsed.records, report.manifest.records);
});

test('generating the same content again returns the same revision; changed facts add a new one without touching the first', async () => {
  const { reports, store } = service();
  const first = await reports.generate({ period, destination: 'regulator' }, actor());
  const again = await reports.generate({ period, destination: 'regulator' }, actor());
  assert.equal(again.created, false); assert.equal(again.report.id, first.report.id); assert.equal(store.revisions.length, 1);
  await reports.send(first.report.id, actor());
  const changed = syntheticFacts();
  changed.payments[0].amount = '1250000.5001'; changed.aggregates = groupRows(changed);
  store.facts_ = changed;
  const second = await reports.generate({ period, destination: 'regulator' }, actor());
  assert.equal(second.created, true); assert.equal(second.report.manifest.revision, 2); assert.notEqual(second.report.contentHash, first.report.contentHash);
  const kept = store.revisions[0];
  assert.equal(kept.contentHash, first.report.contentHash); assert.equal(store.revisions.length, 2);
  assert.equal((await reports.list({}, actor())).items.find(item => item.id === first.report.id)?.delivery?.status, 'acknowledged');
});

test('totals that disagree with the persisted data are never stored', async () => {
  const facts = syntheticFacts();
  facts.aggregates = facts.aggregates.map(group => group.group === 'payment:premium:confirmed' ? { ...group, amount: '1.0000' } : group);
  const { reports, store } = service(facts);
  await assert.rejects(reports.generate({ period, destination: 'regulator' }, actor()), /reconciliation_failed/);
  assert.equal(store.revisions.length, 0);
});

test('an unknown period or a month that has not started is refused before any read', async () => {
  const { reports, store } = service();
  await assert.rejects(reports.generate({ period: nextPeriod(period), destination: 'regulator' }, actor()), /period_in_future/);
  await assert.rejects(reports.generate({ period: '2026-13', destination: 'regulator' }, actor()), /invalid_period/);
  assert.equal(store.revisions.length, 0);
});

test('an expired authorization cannot generate, list, download or send', async () => {
  const { reports, store } = service();
  const expired = { ...actor(), expiresAt: new Date(Date.now() - 1).toISOString() };
  for (const call of [() => reports.generate({ period, destination: 'regulator' }, expired), () => reports.list({}, expired),
    () => reports.download(ids.operator, 'csv', expired), () => reports.send(ids.operator, expired)]) await assert.rejects(call(), /expired/);
  assert.equal(store.audit.length, 0);
});

test('download is audited, hash-checked and refuses a tampered artifact', async () => {
  const { reports, store } = service();
  const { report } = await reports.generate({ period, destination: 'regulator' }, actor());
  const manifest = await reports.download(report.id, 'manifest', actor()) as { body: string; filename: string };
  assert.equal(JSON.parse(manifest.body).contentHash, report.contentHash); assert.equal(manifest.filename, `regulator-${period}-r1.manifest.json`);
  assert.deepEqual(await reports.download(ids.claim(9), 'csv', actor()), { status: 'not_found' });
  assert.deepEqual(store.audit.map(entry => `${entry.action}:${entry.outcome}`), ['reports.generate:created', 'reports.download:success', 'reports.download:not_found']);
  store.revisions[0].content = store.revisions[0].content.replace('1250000.5000', '9250000.5000');
  await assert.rejects(reports.download(report.id, 'csv', actor()), /integrity_violation/);
});

for (const destination of ['regulator', 'reinsurer'] as const) {
  test(`${destination}: dispatch and acknowledgement are separate states and a retry never delivers again`, async () => {
    const { reports, destinations, store } = service();
    const { report } = await reports.generate({ period, destination }, actor());
    const sent = await reports.send(report.id, actor());
    assert.ok(sent.status === 'sent'); assert.equal(sent.delivery.status, 'acknowledged'); assert.match(sent.delivery.reference ?? '', /^MOCK-RPT-/); assert.equal(sent.delivery.attempts, 1);
    const retry = await reports.send(report.id, actor());
    assert.ok(retry.status === 'sent'); assert.deepEqual(retry.delivery, sent.delivery); assert.equal(destinations[destination].deliveries, 1);
    assert.equal(destinations[destination].lookups, 1, 'a final delivery is answered from the stored state without consulting the destination');
    assert.deepEqual(store.audit.map(entry => entry.action).filter(action => action.startsWith('reports.delivery')), ['reports.delivery.acknowledged']);
  });

  test(`${destination}: a timeout is uncertain, and the retry reads what the destination recorded instead of sending again`, async () => {
    const { reports, destinations } = service();
    destinations[destination].silent = true;
    const { report } = await reports.generate({ period, destination }, actor());
    const first = await reports.send(report.id, actor());
    assert.ok(first.status === 'sent'); assert.equal(first.delivery.status, 'uncertain'); assert.equal(first.delivery.reference, null);
    assert.equal((await reports.list({}, actor())).items[0].delivery?.status, 'uncertain');
    const second = await reports.send(report.id, actor());
    assert.ok(second.status === 'sent'); assert.equal(second.delivery.status, 'acknowledged'); assert.equal(destinations[destination].deliveries, 1);
  });
}

test('a destination that never received the delivery gets it once on retry, with the same identity', async () => {
  const { reports, destinations } = service();
  const { report } = await reports.generate({ period, destination: 'regulator' }, actor());
  let failures = 1;
  const real = destinations.regulator.deliver.bind(destinations.regulator);
  const identities: string[] = [];
  destinations.regulator.deliver = async message => { identities.push(message.deliveryId); if (failures-- > 0) throw new Error('network down'); return real(message); };
  const first = await reports.send(report.id, actor());
  assert.ok(first.status === 'sent'); assert.equal(first.delivery.status, 'uncertain');
  const second = await reports.send(report.id, actor());
  assert.ok(second.status === 'sent'); assert.equal(second.delivery.status, 'acknowledged'); assert.equal(second.delivery.attempts, 2);
  assert.equal(new Set(identities).size, 1);
});

test('a rejection is final for that revision and carries the destination code', async () => {
  const { reports, destinations, store } = service();
  const { report } = await reports.generate({ period, destination: 'regulator' }, actor());
  store.revisions[0].manifest = { ...store.revisions[0].manifest, rowCount: store.revisions[0].manifest.rowCount + 1 };
  const sent = await reports.send(report.id, actor());
  assert.ok(sent.status === 'sent'); assert.deepEqual([sent.delivery.status, sent.delivery.rejectionCode], ['rejected', 'totals_mismatch']);
  await reports.send(report.id, actor());
  assert.equal(destinations.regulator.deliveries, 1);
});

test('a missing report is not found and still audited', async () => {
  const { reports, store } = service();
  assert.deepEqual(await reports.send(ids.claim(9), actor()), { status: 'not_found' });
  assert.deepEqual(store.audit.map(entry => `${entry.action}:${entry.outcome}`), ['reports.send:not_found']);
});

for (const destination of ['regulator', 'reinsurer'] as const) {
  test(`${destination} corpus: every valid case is accepted and every negative case is rejected with its own code`, () => {
    const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
    const schema = ajv.compile(read(`schemas/report-delivery-${destination}.v1.json`));
    const { cases } = corpora[destination];
    assert.ok(cases.every(item => item.destination === destination));
    assert.ok(cases.filter(item => item.expected.outcome === 'acknowledged').length >= 2);
    for (const item of cases.filter(candidate => candidate.fault === undefined)) {
      const verdict = reviewDelivery(destination, item.message);
      assert.deepEqual(verdict, item.expected.outcome === 'acknowledged' ? { outcome: 'acknowledged' } : { outcome: 'rejected', code: item.expected.code }, item.name);
      // The envelope contract of this destination: what it accepts is well formed, and a foreign destination or version never validates.
      if (item.expected.outcome === 'acknowledged') assert.equal(schema(item.message), true, `${item.name}: ${JSON.stringify(schema.errors)}`);
      if (['invalid_message', 'unsupported_format_version', 'destination_mismatch'].includes(item.expected.code ?? '')) assert.equal(schema(item.message), false, item.name);
    }
    for (const code of ['hash_mismatch', 'totals_mismatch', 'malformed_csv', 'destination_mismatch', 'unsupported_format_version', 'invalid_message']) assert.ok(cases.some(item => item.expected.code === code), `${destination} ${code}`);
    for (const item of cases.filter(candidate => candidate.fault === 'timeout')) assert.equal(schema(item.message), true, `${item.name}: a delivery that is never answered is still a well formed delivery`);
  });

  test(`${destination} corpus: a delivery whose answer never arrives is recorded by the destination and answered once asked again`, async () => {
    const timeouts = corpora[destination].cases.filter(item => item.fault === 'timeout');
    assert.equal(timeouts.length, 1);
    for (const item of timeouts) {
      const silent = new MemoryDestination(destination);
      silent.silent = true;
      const message = item.message as ReportDelivery;
      assert.equal(await new TimerDeadline().race(silent.deliver(message), 25), 'expired', 'no answer inside the deadline');
      assert.equal(silent.deliveries, 1);
      assert.equal((await silent.lookup(message.deliveryId))?.outcome, item.expected.afterLookup, 'the receipt survives the lost answer');
      silent.silent = false;
      assert.deepEqual(await silent.deliver(message), await silent.lookup(message.deliveryId), 'delivering again returns the original answer');
    }
  });
}

test('each destination rejects the other one\'s artifact even when it is internally consistent', () => {
  assert.deepEqual(reviewDelivery('regulator', deliveryFor('reinsurer', syntheticFacts())), { outcome: 'rejected', code: 'destination_mismatch' });
  assert.deepEqual(reviewDelivery('reinsurer', deliveryFor('regulator', syntheticFacts())), { outcome: 'rejected', code: 'destination_mismatch' });
});

test('the committed valid cases are exactly what the builders produce now', () => {
  for (const destination of ['regulator', 'reinsurer'] as const) {
    const valid = corpora[destination].cases.filter(item => item.expected.outcome === 'acknowledged');
    assert.deepEqual(valid.map(item => item.message), [deliveryFor(destination, syntheticFacts()), deliveryFor(destination, emptyFacts())]);
  }
});
