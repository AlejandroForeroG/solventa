import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfiles, summarize, table } from './dependencies.mjs';

const profile = (latencyMs, dominant, dependencies) => `[solventa-acquisition-risk-local] ${JSON.stringify({ event: 'mortgage_offer_profiled', traceId: 'trace', result: 'created', offerStatus: 'definitive', latencyMs, dominant, dependencies })}`;
const call = (name, durationMs, outcome = 'ok') => ({ name, durationMs, outcome });

test('only profiling lines that carry timings are read, whatever prefixes or noise surround them', () => {
  const log = [
    profile(100, 'offer_write', [call('offer_write', 40)]),
    '[solventa-acquisition-risk-local] {"event":"mortgage_offer_profiled","traceId":"old","result":"created","latencyMs":80}',
    '[solventa-acquisition-risk-local] {"event":"signal_degraded"}',
    'mortgage_offer_profiled {not json',
    ''
  ].join('\n');
  assert.equal(parseProfiles(log).length, 1);
});

test('each dependency gets its percentiles, its errors and how often it was the slowest call', () => {
  const profiles = parseProfiles([
    ...Array.from({ length: 100 }, (_, i) => profile(50 + i, 'provider:payment_history_score', [call('provider:payment_history_score', i + 1), call('offer_write', 5, i === 0 ? 'failed' : 'ok')])),
    profile(900, 'offer_write', [call('provider:payment_history_score', 1), call('offer_write', 800)])
  ].join('\n'));
  const { requests, total, dependencies } = summarize(profiles);
  assert.equal(requests, 101);
  assert.deepEqual(total, { p50: 100, p95: 145, p99: 149 });
  const provider = dependencies.find(d => d.name === 'provider:payment_history_score');
  assert.deepEqual(provider, { name: 'provider:payment_history_score', calls: 101, errors: 0, dominantIn: 100, p50: 50, p95: 95, p99: 99 });
  assert.deepEqual(dependencies.find(d => d.name === 'offer_write'), { name: 'offer_write', calls: 101, errors: 1, dominantIn: 1, p50: 5, p95: 5, p99: 5 });
  assert.equal(dependencies[0].name, 'provider:payment_history_score', 'rows are ordered by p95, slowest first');
});

test('an empty log is reported as such instead of failing', () => {
  assert.match(table(summarize([])), /no profiled offers with timings found/);
});
