import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import type { ConsentCheck, ConsentGuard } from '../backend/acquisition-risk/src/application/ports/consent-guard';
import { ProviderFailure, SIGNAL_DEADLINE_MS } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import type { SignalDegradation, SignalProvider, SignalSnapshot, SignalSnapshots } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import { CONFIDENCE, DEFAULT_SIGNAL_DATA, SIGNAL_SCOPES, defaultSignal, overallConfidence } from '../backend/acquisition-risk/src/domain/signal';
import type { Signal, SignalScope } from '../backend/acquisition-risk/src/domain/signal';
import { underwrite } from '../backend/acquisition-risk/src/domain/offer';
import { ConsoleDegradationTrace, platformTimer } from '../backend/acquisition-risk/src/adapters/outbound/degradation-log';
import { signalProviderFor } from '../backend/acquisition-risk/src/adapters/outbound/signal-providers';

const NOW = new Date('2026-10-19T15:00:00.000Z');
const TRACE = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';
const SUBJECT = '22222222-2222-4222-8222-222222222222';
const CONSENT = 'CNS-2026-00001';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const live = signalProviderFor('direct_simulated', () => NOW);
if (!live) throw Error('direct_simulated must be a known signal provider');

class ScriptedProvider implements SignalProvider {
  reads: SignalScope[] = [];
  behavior: (scope: SignalScope) => Promise<Signal> = scope => live!.read(SUBJECT, scope, TRACE);
  read(_subject: string, scope: SignalScope) { this.reads.push(scope); return this.behavior(scope); }
}
class ManualTimer {
  requested: number[] = [];
  private release: (() => void)[] = [];
  after(milliseconds: number) { this.requested.push(milliseconds); return new Promise<void>(resolve => this.release.push(resolve)); }
  fire() { this.release.splice(0).forEach(resolve => resolve()); }
}
class Snapshots implements SignalSnapshots {
  reads = 0;
  copy: SignalSnapshot | null = null;
  failing = false;
  async find() { this.reads++; if (this.failing) throw new Error('copy_store_down'); return this.copy; }
}

function rig(allowed = true) {
  const provider = new ScriptedProvider(), snapshots = new Snapshots(), timer = new ManualTimer();
  const degradations: { traceId: string; degradation: SignalDegradation }[] = [];
  const check: ConsentCheck = allowed ? { allowed: true, consentId: CONSENT, textVersion: 2, expiresAt: '2027-01-01T00:00:00Z' } : { allowed: false, reason: 'consent_missing' };
  const guard: ConsentGuard = { verify: async () => check };
  const read = new ReadSignal({ guard, provider, snapshots, clock: { now: () => NOW }, timer, trace: { record: (traceId, degradation) => degradations.push({ traceId, degradation }) } });
  const failOn = (...scopes: SignalScope[]) => {
    provider.behavior = scope => scopes.includes(scope) ? Promise.reject(new ProviderFailure('unavailable')) : live!.read(SUBJECT, scope, TRACE);
  };
  return { provider, snapshots, timer, degradations, read, failOn };
}
const ask = (r: ReturnType<typeof rig>, scope: SignalScope = 'payment_history_score') => r.read.execute({ subjectToken: SUBJECT, scope, traceId: TRACE });
const copyOf = (scope: SignalScope, validUntil: string, consentId = CONSENT): SignalSnapshot =>
  ({ consentId, validUntil, signal: { scope, capturedAt: '2026-10-10T10:00:00.000Z', data: { score: 700, latePayments12m: 1 } } });

test('a default never favors the customer: replacing any single live source by its default turns an acceptance into a rejection', async () => {
  const quote = { id: 'q', quoteId: 'Q-1', amount: 100000000, termMonths: 120, ageYears: 40, validUntil: '2026-11-19T00:00:00.000Z' };
  const authorization = { consentId: CONSENT, textVersion: 2, expiresAt: '2027-01-01T00:00:00.000Z' };
  const liveSignals = await Promise.all(SIGNAL_SCOPES.map(scope => live!.read(SUBJECT, scope, TRACE)));
  assert.equal(underwrite(quote, liveSignals, authorization, TRACE)?.accepted, true, 'the live persona is accepted');
  for (const scope of SIGNAL_SCOPES) {
    const replaced = liveSignals.map(signal => signal.scope === scope ? defaultSignal(scope, NOW) : signal);
    assert.equal(underwrite(quote, replaced, authorization, TRACE)?.accepted, false, scope);
  }
  assert.equal(underwrite(quote, SIGNAL_SCOPES.map(scope => defaultSignal(scope, NOW)), authorization, TRACE)?.accepted, false);
});

test('the default of each scope has the same fields and types as what the adapters produce', async () => {
  for (const scope of SIGNAL_SCOPES) {
    const expected = (await live!.read(SUBJECT, scope, TRACE)).data;
    const actual = DEFAULT_SIGNAL_DATA[scope] as Record<string, unknown>;
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), scope);
    for (const key of Object.keys(expected)) assert.equal(typeof actual[key], typeof expected[key], `${scope}.${key}`);
  }
});

test('the overall confidence is the rounded average of the four sources', () => {
  assert.equal(overallConfidence([100, 100, 100, 100]), 100);
  assert.equal(overallConfidence([100, 100, 100, CONFIDENCE.stored_copy]), 90);
  assert.equal(overallConfidence([100, 100, 100, CONFIDENCE.default]), 75);
  assert.equal(overallConfidence([0, 0, 0, 0]), 0);
});

test('a source that answers is not degraded and leaves no trace', async () => {
  const r = rig();
  const result = await ask(r);
  assert.equal(result.status, 'available');
  assert.deepEqual(r.degradations, []);
});

test('a provider that never answers is replaced when the 700 ms limit expires', async () => {
  const r = rig();
  r.provider.behavior = () => new Promise<Signal>(() => {});
  const pending = ask(r);
  await flush();
  assert.deepEqual(r.timer.requested, [SIGNAL_DEADLINE_MS]);
  r.timer.fire();
  const result = await pending;
  assert.ok(result.status === 'degraded');
  assert.deepEqual(result.degradation, { scope: 'payment_history_score', failure: 'timeout', substitute: 'default', confidence: 0 });
  assert.deepEqual(result.signal, defaultSignal('payment_history_score', NOW));
});

test('a normalized provider failure keeps its code and any other error counts as unavailable', async () => {
  for (const [error, failure] of [[new ProviderFailure('rate_limited'), 'rate_limited'], [new ProviderFailure('not_found'), 'not_found'], [new Error('raw provider message'), 'unavailable']] as const) {
    const r = rig();
    r.provider.behavior = () => Promise.reject(error);
    const result = await ask(r);
    assert.ok(result.status === 'degraded');
    assert.equal(result.degradation.failure, failure);
    assert.doesNotMatch(JSON.stringify(r.degradations), /raw provider message/);
  }
});

test('a stored copy replaces the source only under the same consent and before it expires', async () => {
  const cases: [string, SignalSnapshot | null, 'stored_copy' | 'default'][] = [
    ['valid copy', copyOf('payment_history_score', '2026-11-01T00:00:00.000Z'), 'stored_copy'],
    ['copy of another consent', copyOf('payment_history_score', '2026-11-01T00:00:00.000Z', 'CNS-2026-99999'), 'default'],
    ['expired copy', copyOf('payment_history_score', '2026-10-19T14:59:59.000Z'), 'default'],
    ['copy expiring right now', copyOf('payment_history_score', NOW.toISOString()), 'default'],
    ['no copy', null, 'default']
  ];
  for (const [label, copy, substitute] of cases) {
    const r = rig();
    r.failOn('payment_history_score');
    r.snapshots.copy = copy;
    const result = await ask(r);
    assert.ok(result.status === 'degraded', label);
    assert.equal(result.degradation.substitute, substitute, label);
    assert.equal(result.degradation.confidence, substitute === 'stored_copy' ? CONFIDENCE.stored_copy : CONFIDENCE.default, label);
    if (substitute === 'stored_copy') assert.deepEqual(result.signal, copy?.signal, label);
  }
});

test('an unreadable copy is the same as no copy', async () => {
  const r = rig();
  r.failOn('payment_history_score');
  r.snapshots.failing = true;
  const result = await ask(r);
  assert.ok(result.status === 'degraded' && result.degradation.substitute === 'default');
});

test('a copy store that never answers does not hold the default or the other sources', async () => {
  const r = rig();
  r.failOn('payment_history_score');
  r.snapshots.find = () => new Promise<SignalSnapshot | null>(() => {});
  const pending = r.read.executeAll({ subjectToken: SUBJECT, traceId: TRACE });
  await flush();
  r.timer.fire();
  const all = await pending;
  assert.deepEqual(all.results.map(result => result.status), ['available', 'degraded', 'available', 'available']);
  assert.equal(all.confidence, 75);
  assert.equal(r.degradations[0].degradation.substitute, 'default');
});

test('without consent nothing is read, replaced or traced', async () => {
  const r = rig(false);
  r.failOn('payment_history_score');
  assert.deepEqual(await ask(r), { status: 'denied', reason: 'consent_missing' });
  const all = await r.read.executeAll({ subjectToken: SUBJECT, traceId: TRACE });
  assert.equal(all.confidence, 0);
  assert.ok(all.results.every(result => result.status === 'denied'));
  assert.deepEqual({ provider: r.provider.reads.length, copies: r.snapshots.reads, traces: r.degradations.length }, { provider: 0, copies: 0, traces: 0 });
});

test('one failing source is replaced and traced while the other three stay live', async () => {
  const r = rig();
  r.failOn('payment_history_score');
  const all = await r.read.executeAll({ subjectToken: SUBJECT, traceId: TRACE });
  assert.deepEqual(all.results.map(result => result.status), ['available', 'degraded', 'available', 'available']);
  assert.equal(all.confidence, 75);
  assert.deepEqual(r.degradations, [{ traceId: TRACE, degradation: { scope: 'payment_history_score', failure: 'unavailable', substitute: 'default', confidence: 0 } }]);

  r.snapshots.copy = copyOf('payment_history_score', '2026-11-01T00:00:00.000Z');
  assert.equal((await r.read.executeAll({ subjectToken: SUBJECT, traceId: TRACE })).confidence, 90);
});

test('all four sources failing still answers, fully replaced and with no confidence', async () => {
  const r = rig();
  r.failOn(...SIGNAL_SCOPES);
  const all = await r.read.executeAll({ subjectToken: SUBJECT, traceId: TRACE });
  assert.ok(all.results.every(result => result.status === 'degraded'));
  assert.equal(all.confidence, 0);
  assert.deepEqual(r.degradations.map(entry => entry.degradation.scope).sort(), [...SIGNAL_SCOPES].sort());
});

test('the four sources are read in parallel, so one slow source does not delay the others', async () => {
  const r = rig();
  const release: (() => void)[] = [];
  r.provider.behavior = scope => new Promise<Signal>(resolve => release.push(() => resolve({ scope, capturedAt: NOW.toISOString(), data: {} })));
  const pending = r.read.executeAll({ subjectToken: SUBJECT, traceId: TRACE });
  await flush();
  assert.equal(r.provider.reads.length, 4, 'every read started before any answered');
  release.forEach(resolve => resolve());
  assert.equal((await pending).confidence, 100);
});

test('the degradation line carries only normalized values', () => {
  const lines: string[] = [];
  const warn = mock.method(console, 'warn', (line: string) => { lines.push(line); });
  try {
    new ConsoleDegradationTrace().record(TRACE, { scope: 'payment_history_score', failure: 'timeout', substitute: 'default', confidence: 0 });
  } finally { warn.mock.restore(); }
  assert.deepEqual(JSON.parse(lines[0]), { event: 'signal_degraded', traceId: TRACE, rule: 'degradation-1', scope: 'payment_history_score', failure: 'timeout', substitute: 'default', confidence: 0 });
});

test('the platform timer resolves', async () => {
  await platformTimer.after(0);
});
