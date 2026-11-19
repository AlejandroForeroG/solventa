import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readPosition, type PositionWatcher } from '../apps/mobile/src/features/assistance/adapters/device-location';

type Reading = { coords: { latitude: number; longitude: number } };

// A watcher whose subscription can be answered by the test, so the order of events is under control.
function fakeWatcher(options: { startsAfter?: Promise<void> } = {}) {
  let deliver: ((reading: Reading) => void) | undefined;
  const state = { started: 0, removed: 0, dialog: undefined as boolean | undefined };
  const watcher: PositionWatcher = {
    Accuracy: { Balanced: 3 },
    async watchPositionAsync(watchOptions, callback) {
      state.started++;
      state.dialog = watchOptions.mayShowUserSettingsDialog;
      deliver = callback;
      await options.startsAfter;
      return { remove: () => { state.removed++; } };
    },
  };
  return { watcher, state, deliver: (reading: Reading) => deliver?.(reading) };
}
const reading = (latitude: number, longitude: number): Reading => ({ coords: { latitude, longitude } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('the first position is returned and the subscription is removed', async () => {
  const fake = fakeWatcher();
  const pending = readPosition(fake.watcher, new AbortController().signal);
  await tick();
  fake.deliver(reading(4.711, -74.0721));
  assert.deepEqual(await pending, { latitude: 4.711, longitude: -74.0721 });
  assert.equal(fake.state.removed, 1);
});

test('the system settings dialog is never offered while the position is read', async () => {
  const fake = fakeWatcher();
  const controller = new AbortController();
  const pending = readPosition(fake.watcher, controller.signal);
  await tick();
  assert.equal(fake.state.dialog, false);
  controller.abort();
  await pending;
});

test('aborting while the device searches stops the acquisition and returns nothing', async () => {
  const fake = fakeWatcher();
  const controller = new AbortController();
  const pending = readPosition(fake.watcher, controller.signal);
  await tick();
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(fake.state.removed, 1);
  // A position that still arrives afterwards changes nothing and removes nothing twice.
  fake.deliver(reading(1, 1));
  assert.equal(fake.state.removed, 1);
});

test('aborting before the subscription has started removes it as soon as it exists', async () => {
  let start!: () => void;
  const fake = fakeWatcher({ startsAfter: new Promise<void>(resolve => { start = resolve; }) });
  const controller = new AbortController();
  const pending = readPosition(fake.watcher, controller.signal);
  await tick();
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(fake.state.removed, 0);
  start();
  await tick();
  assert.equal(fake.state.removed, 1);
});

test('a signal that is already aborted never starts the device', async () => {
  const fake = fakeWatcher();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await readPosition(fake.watcher, controller.signal), null);
  assert.equal(fake.state.started, 0);
});

test('the deadline rejects and stops the acquisition', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fake = fakeWatcher();
    const pending = readPosition(fake.watcher, new AbortController().signal);
    const outcome = assert.rejects(pending, /location_deadline/);
    await tick();
    mock.timers.tick(10_000);
    await outcome;
    assert.equal(fake.state.removed, 1);
  } finally { mock.timers.reset(); }
});

test('a device that refuses to start is a failure and leaves nothing running', async () => {
  const watcher: PositionWatcher = { Accuracy: { Balanced: 3 }, watchPositionAsync: async () => { throw new Error('unavailable'); } };
  await assert.rejects(readPosition(watcher, new AbortController().signal), /unavailable/);
});
