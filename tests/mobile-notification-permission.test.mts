import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const Platform = { OS: 'android' };
const calls: string[] = [];
let permission = { granted: false, canAskAgain: false, ios: undefined };
mock.module('react-native', { namedExports: { Platform, Linking: { openSettings: async () => { calls.push('settings'); } } } });
mock.module('expo-notifications', { namedExports: {
  AndroidImportance: { DEFAULT: 3 }, IosAuthorizationStatus: { PROVISIONAL: 3 },
  getPermissionsAsync: async () => { calls.push('read'); return permission; },
  requestPermissionsAsync: async () => { calls.push('request'); return { granted: true }; },
  setNotificationChannelAsync: async () => { calls.push('channel'); },
} });
const module = await import('../apps/mobile/src/features/notification-preferences/adapters/push-permission');
const { pushPermission, requestPushPermission, openPushSettings } = module.default ?? module;

test('denied OS permission leaves selected push non-operational and points to Settings', async () => {
  calls.length = 0; permission = { granted: false, canAskAgain: false, ios: undefined };
  assert.equal(await pushPermission(), false);
  assert.equal(await requestPushPermission(), false);
  await openPushSettings();
  assert.deepEqual(calls, ['read', 'channel', 'read', 'settings']);
});

test('Android creates a channel before requesting a permission that can be asked again', async () => {
  calls.length = 0; permission = { granted: false, canAskAgain: true, ios: undefined };
  assert.equal(await requestPushPermission(), true);
  assert.deepEqual(calls, ['channel', 'read', 'request']);
});

test('already granted permission does not prompt again', async () => {
  calls.length = 0; permission = { granted: true, canAskAgain: true, ios: undefined };
  assert.equal(await pushPermission(), true);
  assert.equal(await requestPushPermission(), true);
  assert.deepEqual(calls, ['read', 'channel', 'read']);
});
