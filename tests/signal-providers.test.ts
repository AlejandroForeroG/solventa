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

type Body = Record<string, any>;
const directBody = async (scope: SignalScope): Promise<Body> => (await simulatedDirectSource(clock)(scope, SUBJECT, new AbortController().signal)).body as Body;
const aggregatorBody = async (scope: SignalScope): Promise<Body> => (await simulatedAggregatorSource(clock)(scope, SUBJECT, new AbortController().signal)).body as Body;
const bodies: Record<keyof typeof corpus.providers, (scope: SignalScope) => Promise<Body>> = { direct: directBody, aggregator: aggregatorBody };
const answering = (status: number, body: unknown): ProviderSource => async () => ({ status, body });

// Reads with a body built from the valid simulated answer after `change` edits it; resolves to the signal or the failure code.
async function outcome(provider: keyof typeof adapters, scope: SignalScope, change: (body: Body) => unknown): Promise<unknown> {
  const body = change(structuredClone(await bodies[provider](scope)));
  try { return await adapters[provider](answering(200, body)).read(SUBJECT, scope, TRACE); } catch (error) {
    assert.ok(error instanceof ProviderFailure, `rejected with ${String(error)}`);
    return error.code;
  }
}

const providerNames = Object.keys(adapters) as (keyof typeof adapters)[];

test('every HTTP status maps to one failure code, and a body is only read after a 2xx', async t => {
  capturingLogs(t);
  const expected: [number, string | null][] = [
    [199, 'invalid_response'], [200, null], [201, null], [299, null],
    [300, 'invalid_response'], [301, 'invalid_response'], [304, 'invalid_response'],
    [400, 'invalid_response'], [401, 'unauthorized'], [402, 'invalid_response'], [403, 'unauthorized'], [404, 'not_found'],
    [405, 'invalid_response'], [408, 'invalid_response'], [410, 'invalid_response'], [422, 'invalid_response'], [429, 'rate_limited'],
    [499, 'invalid_response'], [500, 'unavailable'], [502, 'unavailable'], [503, 'unavailable'], [599, 'unavailable']
  ];
  for (const provider of providerNames) {
    const valid = await bodies[provider]('identity_validation');
    for (const [status, code] of expected) {
      const read = adapters[provider](answering(status, valid)).read(SUBJECT, 'identity_validation', TRACE);
      if (code) assert.equal(await failureOf(read), code, `${provider} ${status}`);
      else assert.equal((await read).scope, 'identity_validation', `${provider} ${status}`);
    }
  }
});

test('a source that rejects with a ProviderFailure keeps its code, and any other rejection is unavailable', async t => {
  const lines = capturingLogs(t);
  for (const provider of providerNames) {
    const rejecting = (reason: unknown): ProviderSource => async () => { throw reason; };
    assert.equal(await failureOf(adapters[provider](rejecting(new ProviderFailure('rate_limited'))).read(SUBJECT, 'payment_history_score', TRACE)), 'rate_limited');
    for (const reason of [new TypeError('fetch failed'), 'plain string', null, undefined, { code: 'timeout' }]) {
      assert.equal(await failureOf(adapters[provider](rejecting(reason)).read(SUBJECT, 'payment_history_score', TRACE)), 'unavailable', String(reason));
    }
  }
  assert.ok(lines.every(line => JSON.parse(line).event === 'signal_provider_failed'));
});

test('the source receives the scope and subject token it is asked for, and a live cancellation signal', async () => {
  for (const provider of providerNames) {
    for (const scope of SIGNAL_SCOPES) {
      const valid = await bodies[provider](scope);
      let seen: { scope: SignalScope; subject: string; cancelledBefore: boolean } | undefined;
      const source: ProviderSource = async (s, subject, signal) => { seen = { scope: s, subject, cancelledBefore: signal.aborted }; return { status: 200, body: valid }; };
      await adapters[provider](source).read(SUBJECT, scope, TRACE);
      assert.deepEqual(seen, { scope, subject: SUBJECT, cancelledBefore: false }, `${provider} ${scope}`);
    }
  }
});

test('an answer inside the deadline succeeds, is not cancelled before it arrives and leaves no timeout behind', async t => {
  const lines = capturingLogs(t);
  for (const provider of providerNames) {
    const valid = await bodies[provider]('identity_validation');
    let cancelledWhileWaiting = true;
    const slow: ProviderSource = (_scope, _subject, signal) => new Promise(resolve => setTimeout(() => { cancelledWhileWaiting = signal.aborted; resolve({ status: 200, body: valid }); }, 10));
    assert.deepEqual((await adapters[provider](slow, 500).read(SUBJECT, 'identity_validation', TRACE)).data, { verified: true });
    assert.equal(cancelledWhileWaiting, false);
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(lines.length, 0);
});

test('the call is cancelled after any outcome so a source cannot keep working', async t => {
  capturingLogs(t);
  for (const provider of providerNames) {
    const valid = await bodies[provider]('identity_validation');
    for (const response of [() => ({ status: 200, body: valid }), () => ({ status: 503, body: null }), () => { throw new Error('boom'); }]) {
      let signalSeen: AbortSignal | undefined;
      const source: ProviderSource = async (_scope, _subject, signal) => { signalSeen = signal; return response(); };
      await adapters[provider](source).read(SUBJECT, 'identity_validation', TRACE).catch(() => undefined);
      assert.equal(signalSeen?.aborted, true, provider);
    }
  }
});

test('a late answer after the deadline does not replace the timeout failure', async t => {
  capturingLogs(t);
  for (const provider of providerNames) {
    const valid = await bodies[provider]('identity_validation');
    const late: ProviderSource = () => new Promise(resolve => setTimeout(() => resolve({ status: 200, body: valid }), 60));
    assert.equal(await failureOf(adapters[provider](late, 10).read(SUBJECT, 'identity_validation', TRACE)), 'timeout');
  }
});

test('the default deadline is 700 ms: the call is still pending just before it and times out at it', async t => {
  capturingLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent: ProviderSource = () => new Promise(() => undefined);
  let settled = false;
  const outcome = failureOf(new DirectSignalProvider('direct_test', silent).read(SUBJECT, 'identity_validation', TRACE)).then(code => { settled = true; return code; });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(699);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, true);
  assert.equal(await outcome, 'timeout');
});

test('no failure log carries the subject token, the provider message or the provider body', async t => {
  const lines = capturingLogs(t);
  const secret = 'subject-token-confidential-9f2c';
  const echoing: ProviderSource[] = [
    async () => ({ status: 400, body: { mensaje: `bad token ${secret}` } }),
    async () => ({ status: 200, body: { estadoCedula: `NO_VIGENTE_${secret}` } }),
    async () => ({ status: 200, body: { estado: 'OK', fuente: secret } }),
    async () => { throw new Error(`connect failed for ${secret}`); },
    async () => ({ status: 429, body: `slow down ${secret}` })
  ];
  for (const provider of providerNames) {
    for (const source of echoing) await failureOf(adapters[provider](source).read(secret, 'identity_validation', TRACE));
  }
  assert.equal(lines.length, echoing.length * providerNames.length);
  for (const line of lines) {
    assert.ok(!line.includes(secret) && !line.includes('connect failed') && !line.includes('bad token'), line);
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['code', 'event', 'provider', 'scope', 'traceId']);
  }
});

for (const provider of providerNames) {
  test(`${provider} rejects a body that is not an object for every scope`, async t => {
    capturingLogs(t);
    for (const scope of SIGNAL_SCOPES) {
      for (const malformed of [null, undefined, [], [{}], 'text', 42, true, {}]) {
        assert.equal(await outcome(provider, scope, () => malformed), 'invalid_response', `${scope} ${JSON.stringify(malformed)}`);
      }
    }
  });
}

test('direct translators reject wrongly typed, missing and out of range fields', async t => {
  capturingLogs(t);
  const cases: [SignalScope, string, (body: Body) => unknown][] = [
    ['income_obligations_12m', 'data is an array', body => ({ data: [body.data] })],
    ['income_obligations_12m', 'data is null', () => ({ data: null })],
    ['income_obligations_12m', 'negative income', body => { body.data.incomeMonthlyCents = -1; return body; }],
    ['income_obligations_12m', 'fractional income', body => { body.data.incomeMonthlyCents = 1.5; return body; }],
    ['income_obligations_12m', 'income beyond the safe integers', body => { body.data.incomeMonthlyCents = Number.MAX_SAFE_INTEGER + 2; return body; }],
    ['income_obligations_12m', 'income as null', body => { body.data.incomeMonthlyCents = null; return body; }],
    ['income_obligations_12m', 'obligations missing', body => { delete body.data.obligationsMonthlyCents; return body; }],
    ['income_obligations_12m', 'negative obligations', body => { body.data.obligationsMonthlyCents = -100; return body; }],
    ['income_obligations_12m', 'period of 11 months', body => { body.data.periodMonths = 11; return body; }],
    ['income_obligations_12m', 'period of 13 months', body => { body.data.periodMonths = 13; return body; }],
    ['income_obligations_12m', 'period as text', body => { body.data.periodMonths = '12'; return body; }],
    ['income_obligations_12m', 'period missing', body => { delete body.data.periodMonths; return body; }],
    ['income_obligations_12m', 'cut-off missing', body => { delete body.data.asOf; return body; }],
    ['income_obligations_12m', 'cut-off as epoch number', body => { body.data.asOf = 1760626800000; return body; }],
    ['payment_history_score', 'consulta missing', () => ({ resultado: {} })],
    ['payment_history_score', 'score above the scale', body => { body.consulta.puntaje = 1001; return body; }],
    ['payment_history_score', 'negative score', body => { body.consulta.puntaje = -1; return body; }],
    ['payment_history_score', 'fractional score', body => { body.consulta.puntaje = 742.5; return body; }],
    ['payment_history_score', 'score as text', body => { body.consulta.puntaje = '742'; return body; }],
    ['payment_history_score', 'negative late payments', body => { body.consulta.moras12m = -1; return body; }],
    ['payment_history_score', 'fractional late payments', body => { body.consulta.moras12m = 0.5; return body; }],
    ['payment_history_score', 'late payments missing', body => { delete body.consulta.moras12m; return body; }],
    ['payment_history_score', 'query date missing', body => { delete body.consulta.fechaConsulta; return body; }],
    ['affiliation_regime', 'affiliations missing', body => { delete body.afiliaciones; return body; }],
    ['affiliation_regime', 'affiliations as an object', body => ({ ...body, afiliaciones: body.afiliaciones[1] })],
    ['affiliation_regime', 'a null entry', body => ({ ...body, afiliaciones: [null, ...body.afiliaciones] })],
    ['affiliation_regime', 'a text entry', body => ({ ...body, afiliaciones: ['SALUD'] })],
    ['affiliation_regime', 'inherited regime name', body => { body.afiliaciones[1].regimen = 'toString'; return body; }],
    ['affiliation_regime', 'lowercase regime', body => { body.afiliaciones[1].regimen = 'contributivo'; return body; }],
    ['affiliation_regime', 'regime missing', body => { delete body.afiliaciones[1].regimen; return body; }],
    ['affiliation_regime', 'inherited state name', body => { body.afiliaciones[1].estado = 'constructor'; return body; }],
    ['affiliation_regime', 'state as boolean', body => { body.afiliaciones[1].estado = true; return body; }],
    ['affiliation_regime', 'state missing', body => { delete body.afiliaciones[1].estado; return body; }],
    ['affiliation_regime', 'cut-off missing', body => { delete body.fechaCorte; return body; }],
    ['identity_validation', 'inherited document state', body => ({ ...body, estadoCedula: '__proto__' })],
    ['identity_validation', 'lowercase document state', body => ({ ...body, estadoCedula: 'vigente' })],
    ['identity_validation', 'document state as boolean', body => ({ ...body, estadoCedula: true })],
    ['identity_validation', 'document state missing', body => { delete body.estadoCedula; return body; }],
    ['identity_validation', 'query date missing', body => { delete body.fechaConsulta; return body; }]
  ];
  for (const [scope, label, change] of cases) assert.equal(await outcome('direct', scope, change), 'invalid_response', `${scope}: ${label}`);
});

test('aggregator translators reject wrongly typed, missing and out of range fields', async t => {
  capturingLogs(t);
  const cases: [SignalScope, string, (body: Body) => unknown][] = [
    ['identity_validation', 'state missing', body => { delete body.estado; return body; }],
    ['identity_validation', 'lowercase state', body => ({ ...body, estado: 'ok' })],
    ['identity_validation', 'inherited state name', body => ({ ...body, estado: 'toString' })],
    ['identity_validation', 'source missing', body => { delete body.fuente; return body; }],
    ['identity_validation', 'source of another scope', body => ({ ...body, fuente: 'ruaf' })],
    ['identity_validation', 'result missing', body => { delete body.resultado; return body; }],
    ['identity_validation', 'result as an array', body => ({ ...body, resultado: [body.resultado] })],
    ['identity_validation', 'result as null', body => ({ ...body, resultado: null })],
    ['identity_validation', 'validity as text', body => { body.resultado.cedula_vigente = 'true'; return body; }],
    ['identity_validation', 'validity as number', body => { body.resultado.cedula_vigente = 1; return body; }],
    ['identity_validation', 'validity missing', body => { delete body.resultado.cedula_vigente; return body; }],
    ['identity_validation', 'cut-off missing', body => { delete body.fecha_corte; return body; }],
    ['identity_validation', 'cut-off as null', body => ({ ...body, fecha_corte: null })],
    ['income_obligations_12m', 'negative income', body => { body.resultado.ingresos_promedio_mensual = -1; return body; }],
    ['income_obligations_12m', 'fractional income', body => { body.resultado.ingresos_promedio_mensual = 1.5; return body; }],
    ['income_obligations_12m', 'income as text', body => { body.resultado.ingresos_promedio_mensual = '4500000'; return body; }],
    ['income_obligations_12m', 'obligations missing', body => { delete body.resultado.obligaciones_mensuales; return body; }],
    ['income_obligations_12m', 'negative obligations', body => { body.resultado.obligaciones_mensuales = -1; return body; }],
    ['payment_history_score', 'score above the scale', body => { body.resultado.score = 1001; return body; }],
    ['payment_history_score', 'negative score', body => { body.resultado.score = -1; return body; }],
    ['payment_history_score', 'score as text', body => { body.resultado.score = '742'; return body; }],
    ['payment_history_score', 'negative late payments', body => { body.resultado.moras_ultimos_12_meses = -1; return body; }],
    ['payment_history_score', 'late payments missing', body => { delete body.resultado.moras_ultimos_12_meses; return body; }],
    ['affiliation_regime', 'lowercase regime code', body => { body.resultado.regimen_salud = 'c'; return body; }],
    ['affiliation_regime', 'inherited regime name', body => { body.resultado.regimen_salud = 'constructor'; return body; }],
    ['affiliation_regime', 'long regime name', body => { body.resultado.regimen_salud = 'CONTRIBUTIVO'; return body; }],
    ['affiliation_regime', 'regime missing', body => { delete body.resultado.regimen_salud; return body; }],
    ['affiliation_regime', 'activity as text', body => { body.resultado.afiliado_activo = 'true'; return body; }],
    ['affiliation_regime', 'activity missing', body => { delete body.resultado.afiliado_activo; return body; }]
  ];
  for (const [scope, label, change] of cases) assert.equal(await outcome('aggregator', scope, change), 'invalid_response', `${scope}: ${label}`);
});

test('aggregator reports its own failure states before looking at the rest of the envelope', async t => {
  capturingLogs(t);
  for (const scope of SIGNAL_SCOPES) {
    assert.equal(await outcome('aggregator', scope, () => ({ estado: 'SIN_DATOS' })), 'not_found', scope);
    assert.equal(await outcome('aggregator', scope, () => ({ estado: 'ERROR_FUENTE', fuente: 'another', resultado: 7 })), 'unavailable', scope);
  }
});

test('translators accept the boundary values of the scale and the counts', async () => {
  const direct = (scope: SignalScope, change: (body: Body) => void) => outcome('direct', scope, body => { change(body); return body; });
  const aggregator = (scope: SignalScope, change: (body: Body) => void) => outcome('aggregator', scope, body => { change(body); return body; });
  const data = (signal: unknown) => (signal as Signal).data;
  assert.deepEqual(data(await direct('payment_history_score', body => { body.consulta.puntaje = 1000; body.consulta.moras12m = 12; })), { score: 1000, latePayments12m: 12 });
  assert.deepEqual(data(await direct('payment_history_score', body => { body.consulta.puntaje = 0; })), { score: 0, latePayments12m: 0 });
  assert.deepEqual(data(await aggregator('payment_history_score', body => { body.resultado.score = 1000; })), { score: 1000, latePayments12m: 0 });
  assert.deepEqual(data(await aggregator('payment_history_score', body => { body.resultado.score = 0; })), { score: 0, latePayments12m: 0 });
  assert.deepEqual(data(await direct('income_obligations_12m', body => { body.data.incomeMonthlyCents = 0; body.data.obligationsMonthlyCents = 0; })), { monthlyIncomeCop: 0, monthlyObligationsCop: 0 });
  assert.deepEqual(data(await aggregator('income_obligations_12m', body => { body.resultado.ingresos_promedio_mensual = 0; body.resultado.obligaciones_mensuales = 0; })), { monthlyIncomeCop: 0, monthlyObligationsCop: 0 });
});

test('the direct translator converts COP cents to whole pesos, rounding to the nearest peso', async () => {
  const pesos = async (income: number, obligations: number) => (await outcome('direct', 'income_obligations_12m', body => {
    body.data.incomeMonthlyCents = income;
    body.data.obligationsMonthlyCents = obligations;
    return body;
  }) as Signal).data;
  assert.deepEqual(await pesos(450000049, 49), { monthlyIncomeCop: 4500000, monthlyObligationsCop: 0 });
  assert.deepEqual(await pesos(450000050, 50), { monthlyIncomeCop: 4500001, monthlyObligationsCop: 1 });
});

test('the direct translator takes the health affiliation whatever its position and ignores other subsystems', async () => {
  const body = await directBody('affiliation_regime');
  body.afiliaciones = [
    { subsistema: 'SALUD', regimen: 'ESPECIAL', estado: 'SUSPENDIDO' },
    { subsistema: 'SALUD', regimen: 'CONTRIBUTIVO', estado: 'ACTIVO' }
  ];
  const first = await adapters.direct(answering(200, body)).read(SUBJECT, 'affiliation_regime', TRACE);
  assert.deepEqual(first.data, { regime: 'special', active: false });
  body.afiliaciones = [{ subsistema: 'PENSION', regimen: 'CONTRIBUTIVO', estado: 'ACTIVO' }, { subsistema: 'SALUD', regimen: 'SUBSIDIADO', estado: 'ACTIVO' }];
  assert.deepEqual((await adapters.direct(answering(200, body)).read(SUBJECT, 'affiliation_regime', TRACE)).data, { regime: 'subsidized', active: true });
});

test('every known state code maps to its internal value', async () => {
  const states: [string, string, boolean][] = [['CONTRIBUTIVO', 'ACTIVO', true], ['SUBSIDIADO', 'RETIRADO', false], ['ESPECIAL', 'SUSPENDIDO', false]];
  const regimes = ['contributory', 'subsidized', 'special'];
  for (const [index, [regimen, estado, active]] of states.entries()) {
    const body = await directBody('affiliation_regime');
    body.afiliaciones = [{ subsistema: 'SALUD', regimen, estado }];
    assert.deepEqual((await adapters.direct(answering(200, body)).read(SUBJECT, 'affiliation_regime', TRACE)).data, { regime: regimes[index], active });
  }
  for (const [code, regime] of [['C', 'contributory'], ['S', 'subsidized'], ['E', 'special']]) {
    assert.deepEqual((await outcome('aggregator', 'affiliation_regime', body => { body.resultado.regimen_salud = code; body.resultado.afiliado_activo = false; return body; }) as Signal).data, { regime, active: false }, code);
  }
  for (const [estadoCedula, verified] of [['VIGENTE', true], ['CANCELADA', false], ['CANCELADA_POR_MUERTE', false]] as const) {
    assert.deepEqual((await outcome('direct', 'identity_validation', body => ({ ...body, estadoCedula })) as Signal).data, { verified }, estadoCedula);
  }
  assert.equal(await outcome('direct', 'identity_validation', body => ({ ...body, estadoCedula: 'NO_REGISTRA' })), 'not_found');
});

test('provider dates are read as exact calendar dates and instants, and returned as UTC instants', async t => {
  capturingLogs(t);
  const valid: [string, string][] = [
    ['2026-10-16', '2026-10-16T05:00:00.000Z'],
    ['2028-02-29', '2028-02-29T05:00:00.000Z'],
    ['2026-12-31', '2026-12-31T05:00:00.000Z'],
    ['2026-10-16T15:00:00Z', '2026-10-16T15:00:00.000Z'],
    ['2026-10-16T15:00:00.5Z', '2026-10-16T15:00:00.500Z'],
    ['2026-10-16T15:00:00.123Z', '2026-10-16T15:00:00.123Z'],
    ['2026-10-16T10:00:00-05:00', '2026-10-16T15:00:00.000Z'],
    ['2026-10-16T10:00:00+05:30', '2026-10-16T04:30:00.000Z'],
    ['2026-10-16T23:59:59Z', '2026-10-16T23:59:59.000Z'],
    ['2026-10-16T00:00:00Z', '2026-10-16T00:00:00.000Z']
  ];
  const invalid = [
    '', ' ', 'yesterday', '2026-10-16 15:00:00Z', ' 2026-10-16', '2026-10-16 ', '2026-10-16\n', '2026-1-6', '20261016',
    '2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32',
    '2026-02-30T10:00:00Z', '2026-10-16T24:00:00Z', '2026-10-16T10:60:00Z', '2026-10-16T10:00:60Z', '2026-10-16T25:00:00Z',
    '2026-10-16T15:00:00', '2026-10-16T15:00Z', '2026-10-16T15:00:00.Z', '2026-10-16T15:00:00.1234Z',
    '2026-10-16T15:00:00+24:00', '2026-10-16T15:00:00+05:60', '2026-10-16T15:00:00+0500', '2026-10-16t15:00:00z'
  ];
  for (const provider of providerNames) {
    const field = (value: unknown) => (body: Body) => {
      if (provider === 'direct') body.consulta.fechaConsulta = value; else body.fecha_corte = value;
      return body;
    };
    for (const [text, instantOf] of valid) {
      assert.equal(((await outcome(provider, 'payment_history_score', field(text))) as Signal).capturedAt, instantOf, `${provider} ${text}`);
    }
    for (const text of invalid) assert.equal(await outcome(provider, 'payment_history_score', field(text)), 'invalid_response', `${provider} "${text}"`);
    for (const value of [null, undefined, 20261016, true, {}, ['2026-10-16']]) assert.equal(await outcome(provider, 'payment_history_score', field(value)), 'invalid_response', `${provider} ${JSON.stringify(value)}`);
  }
});

test('SIGNAL_PROVIDER ignores names inherited from the object prototype or written with other spacing', () => {
  for (const name of ['hasOwnProperty', 'valueOf', 'isPrototypeOf', 'toLocaleString', '__defineGetter__', ' direct_simulated', 'direct_simulated ', 'Aggregator_Simulated', 'direct_simulated\n']) {
    assert.equal(signalProviderFor(name), null, JSON.stringify(name));
  }
});

test('simulated providers use the injected clock for every answer, and the real clock when none is given', async () => {
  const later = new Date('2027-03-04T05:06:07.089Z');
  for (const name of ['direct_simulated', 'aggregator_simulated']) {
    const provider = signalProviderFor(name, () => later);
    assert.ok(provider);
    for (const scope of SIGNAL_SCOPES) assert.equal((await provider.read(SUBJECT, scope, TRACE)).capturedAt, later.toISOString(), `${name} ${scope}`);

    const real = signalProviderFor(name);
    assert.ok(real);
    const before = Date.now();
    const { capturedAt } = await real.read(SUBJECT, 'identity_validation', TRACE);
    assert.ok(Date.parse(capturedAt) >= before && Date.parse(capturedAt) <= Date.now(), `${name} ${capturedAt}`);
  }
});
