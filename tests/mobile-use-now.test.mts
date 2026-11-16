import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Minimal hook runtime: one state slot and effects that run immediately, enough to drive the clock hook.
let slot: number | undefined;
const setters: number[] = [];
const cleanups: Array<() => void> = [];
mock.module('react', { namedExports: {
  useState: (initial: unknown) => {
    slot ??= (typeof initial === 'function' ? (initial as () => number)() : initial) as number;
    return [slot, (value: number) => { slot = value; setters.push(value); }];
  },
  useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
} });

const { useNow } = await import('../apps/mobile/src/features/policy-wallet/presentation/use-now');

test('the clock hook starts from the current time, advances every minute and stops when the screen goes away', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
  assert.equal(useNow(), 1_800_000_000_000);
  mock.timers.tick(60_000);
  assert.deepEqual(setters, [1_800_000_060_000], 'a policy that starts or expires while the wallet is open sees the new time');
  mock.timers.tick(60_000);
  assert.equal(setters.length, 2);
  for (const cleanup of cleanups) cleanup();
  mock.timers.tick(180_000);
  assert.equal(setters.length, 2, 'no more updates after the screen unmounts');
  mock.timers.reset();
});
