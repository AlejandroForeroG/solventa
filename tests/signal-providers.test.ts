import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { AggregatorSignalProvider, simulatedAggregatorSource } from '../backend/acquisition-risk/src/adapters/outbound/aggregator-signal-provider';
import { DirectSignalProvider, simulatedDirectSource } from '../backend/acquisition-risk/src/adapters/outbound/direct-signal-provider';
import { signalProviderFor } from '../backend/acquisition-risk/src/adapters/outbound/signal-providers';
import type { ProviderSource } from '../backend/acquisition-risk/src/adapters/outbound/signal-provider-call';
import { ReadSignal } from '../backend/acquisition-risk/src/application/read-signal';
import { PROVIDER_FAILURES, ProviderFailure } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import type { SignalProvider, SignalSnapshots } from '../backend/acquisition-risk/src/application/ports/signal-sources';
import type { ConsentGuard } from '../backend/acquisition-risk/src/application/ports/consent-guard';
import { SIGNAL_SCOPES } from '../backend/acquisition-risk/src/domain/signal';
import { underwrite } from '../backend/acquisition-risk/src/domain/offer';
import type { Signal, SignalScope } from '../backend/acquisition-risk/src/domain/signal';

type Case = { name: string; scope: SignalScope; response: { status: number; body: unknown }; expected: { signal: Signal } | { failure: string } };
const corpus: { providers: Record<'direct' | 'aggregator', Case[]> } = JSON.parse(readFileSync(new URL('../packages/contracts/examples/signal-providers.json', import.meta.url), 'utf8'));
const adapters: Record<keyof typeof corpus.providers, (source: ProviderSource, deadlineMs?: number) => SignalProvider> = {
  direct: (source, deadlineMs) => new DirectSignalProvider('direct_test', source, deadlineMs),
  aggregator: (source, deadlineMs) => new AggregatorSignalProvider('aggregator_test', source, deadlineMs)
};
const SUBJECT = 'subject-token-ana';
const TRACE = '7f3c2a9e-1b4d-4c8e-9a52-0d6e8f1a3b47';
const QUERIED_AT = new Date('2026-10-16T15:00:00.000Z');
const clock = () => QUERIED_AT;

// Captures what the adapter logs, so a test can assert the reason is recorded and nothing sensitive is.
function capturingLogs(t: { mock: { method: (target: Console, name: 'error', fn: (line: string) => void) => unknown } }) {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => { lines.push(line); });
  return lines;
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ProviderFailure, `rejected with ${String(error)}`);
    return error.code;
  }
  assert.fail('the provider answered instead of failing');
}

for (const [provider, cases] of Object.entries(corpus.providers) as [keyof typeof corpus.providers, Case[]][]) {
  for (const item of cases) {
    test(`${provider} corpus case ${item.name}`, async t => {
      const lines = capturingLogs(t);
      const adapter = adapters[provider](async () => item.response);
      if ('signal' in item.expected) {
        assert.deepEqual(await adapter.read(SUBJECT, item.scope, TRACE), item.expected.signal);
        assert.equal(lines.length, 0);
        return;
      }
      assert.equal(await failureOf(adapter.read(SUBJECT, item.scope, TRACE)), item.expected.failure);
      assert.equal(lines.length, 1);
      // An exact match: the reason is recorded, and the subject token or provider payload cannot be.
      assert.deepEqual(JSON.parse(lines[0]), { event: 'signal_provider_failed', traceId: TRACE, provider: `${provider}_test`, scope: item.scope, code: item.expected.failure });
    });
  }
}

test('the corpus covers every scope of both providers and every normalized failure', () => {
  for (const cases of Object.values(corpus.providers)) {
    for (const scope of SIGNAL_SCOPES) assert.ok(cases.some(item => item.scope === scope && 'signal' in item.expected), scope);
  }
  const codes = new Set(Object.values(corpus.providers).flat().flatMap(item => ('failure' in item.expected ? [item.expected.failure] : [])));
  for (const code of PROVIDER_FAILURES.filter(code => code !== 'timeout')) assert.ok(codes.has(code), code);
});

test('a provider that does not answer within the deadline fails as timeout and is cancelled', async t => {
  const lines = capturingLogs(t);
  let cancelled = false;
  const silent: ProviderSource = (_scope, _subject, signal) => new Promise(() => { signal.addEventListener('abort', () => { cancelled = true; }); });
  for (const make of Object.values(adapters)) {
    cancelled = false;
    assert.equal(await failureOf(make(silent, 20).read(SUBJECT, 'payment_history_score', TRACE)), 'timeout');
    assert.equal(cancelled, true);
  }
  assert.equal(lines.length, 2);
});

test('a transport error is reported as unavailable without its message', async t => {
  const lines = capturingLogs(t);
  const broken: ProviderSource = async () => { throw new Error('getaddrinfo ENOTFOUND api.provider.example'); };
  for (const make of Object.values(adapters)) assert.equal(await failureOf(make(broken).read(SUBJECT, 'identity_validation', TRACE)), 'unavailable');
  assert.ok(lines.every(line => !line.includes('ENOTFOUND')));
});

test('both simulated providers give the same signal for every scope', async () => {
  const direct = new DirectSignalProvider('direct_simulated', simulatedDirectSource(clock));
  const aggregator = new AggregatorSignalProvider('aggregator_simulated', simulatedAggregatorSource(clock));
  for (const scope of SIGNAL_SCOPES) assert.deepEqual(await aggregator.read(SUBJECT, scope, TRACE), await direct.read(SUBJECT, scope, TRACE), scope);
});

test('SIGNAL_PROVIDER selects a provider, and only a known name does', () => {
  assert.ok(signalProviderFor('direct_simulated') instanceof DirectSignalProvider);
  assert.ok(signalProviderFor('aggregator_simulated') instanceof AggregatorSignalProvider);
  for (const name of [undefined, '', 'direct', 'DIRECT_SIMULATED', 'toString', '__proto__', 'constructor']) assert.equal(signalProviderFor(name), null, String(name));
});

test('ReadSignal behaves the same whichever provider the configuration selects', async () => {
  const guard: ConsentGuard = { verify: async () => ({ allowed: true, consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-06T15:00:00Z' }) };
  const snapshots: SignalSnapshots = { find: async () => null };
  const results = [];
  for (const name of ['direct_simulated', 'aggregator_simulated']) {
    const provider = signalProviderFor(name, clock);
    assert.ok(provider);
    const read = new ReadSignal({ guard, provider, snapshots });
    results.push(await Promise.all(SIGNAL_SCOPES.map(scope => read.execute({ subjectToken: SUBJECT, scope, traceId: TRACE }))));
  }
  assert.ok(results[0].every(result => result.status === 'available'));
  assert.deepEqual(results[1], results[0]);
});

// Substituting a provider changes an adapter and SIGNAL_PROVIDER only: the core cannot depend on either.
test('the core names no provider, external format or provider configuration', () => {
  const core = ['domain', 'application'].flatMap(layer => {
    const dir = new URL(`../backend/acquisition-risk/src/${layer}/`, import.meta.url);
    return readdirSync(dir, { recursive: true }).map(String).filter(file => file.endsWith('.ts')).map(file => new URL(file, dir));
  });
  assert.ok(core.length >= 5);
  const external = ['SIGNAL_PROVIDER', 'direct_simulated', 'aggregator_simulated', 'DirectSignalProvider', 'AggregatorSignalProvider', 'incomeMonthlyCents', 'puntaje', 'afiliaciones', 'estadoCedula', 'fecha_corte', 'TXLifeRequest', 'GovtID', 'MORTGAGE_LIFE'];
  for (const file of core) {
    const source = readFileSync(file, 'utf8');
    for (const term of external) assert.ok(!source.includes(term), `${file.pathname} mentions ${term}`);
  }
});

test('simulated answers are stamped with the query time, so consumers see a fresh signal', async () => {
  for (const name of ['direct_simulated', 'aggregator_simulated']) {
    const provider = signalProviderFor(name, clock);
    assert.ok(provider);
    for (const scope of SIGNAL_SCOPES) assert.equal((await provider.read(SUBJECT, scope, TRACE)).capturedAt, QUERIED_AT.toISOString(), `${name} ${scope}`);
  }
});

// The offer underwriting rule is a real consumer of the port: either adapter must be able to feed it.
test('both simulated adapters produce the signal fields the offer underwriting reads', async () => {
  const quote = { id: 'q-1', quoteId: 'COT-2026-00123', amount: 320000000, termMonths: 180, ageYears: 34, validUntil: '2026-11-05T15:00:00.000Z' };
  const authorization = { consentId: 'CNS-2026-00001', textVersion: 2, expiresAt: '2027-01-06T15:00:00Z' };
  const premiums = [];
  for (const name of ['direct_simulated', 'aggregator_simulated']) {
    const provider = signalProviderFor(name, clock);
    assert.ok(provider);
    const signals = await Promise.all(SIGNAL_SCOPES.map(scope => provider.read(SUBJECT, scope, TRACE)));
    const decision = underwrite(quote, signals, authorization, TRACE);
    assert.ok(decision?.accepted, `${name} must be accepted by the underwriting rule`);
    if (decision?.accepted) premiums.push(decision.premium);
  }
  assert.equal(premiums[1], premiums[0]);
});
