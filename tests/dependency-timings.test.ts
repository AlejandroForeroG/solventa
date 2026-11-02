import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyTimings } from '../backend/acquisition-risk/src/application/dependency-timings';

function timings() {
  let now = Date.parse('2026-10-26T10:00:00.000Z');
  return { timings: new DependencyTimings({ now: () => new Date(now) }), advance: (milliseconds: number) => { now += milliseconds; } };
}

test('a measured call records its duration and outcome, and a failure is still thrown', async () => {
  const { timings: t, advance } = timings();
  assert.equal(await t.measure('identity_access', async () => { advance(12); return 'answer'; }), 'answer');
  await assert.rejects(t.measure('offer_write', async () => { advance(30); throw new Error('write_failed'); }), /write_failed/);
  assert.deepEqual(t.summary().dependencies, [
    { name: 'identity_access', durationMs: 12, outcome: 'ok' },
    { name: 'offer_write', durationMs: 30, outcome: 'failed' }
  ]);
});

test('the dominant dependency is the slowest single call, even when it failed', async () => {
  const { timings: t, advance } = timings();
  await t.measure('offer_read', async () => advance(5));
  await t.measure('provider:payment_history_score', async () => advance(90)).catch(() => {});
  await t.measure('offer_write', async () => advance(40));
  assert.equal(t.summary().dominant, 'provider:payment_history_score');
});

test('with no call there is no dominant dependency', () => {
  assert.deepEqual(timings().timings.summary(), { dominant: null, dependencies: [] });
});

test('the summary is a copy: changing it does not alter what was recorded', async () => {
  const { timings: t } = timings();
  await t.measure('offer_read', async () => {});
  t.summary().dependencies.pop();
  assert.equal(t.summary().dependencies.length, 1);
});
