import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { messages, messagesForLocales, resolveLanguage } from '../apps/mobile/src/shared/i18n/messages';
import type { FailureKind } from '../apps/mobile/src/features/authentication/domain/session';

test('device language selection handles regional variants and preserves preferred locale order', () => {
  for (const tag of ['es', 'es-CO', 'es-419', 'ES-es']) assert.equal(resolveLanguage([tag]), 'es');
  for (const tag of ['en', 'en-US', 'en-GB', 'EN-ca']) assert.equal(resolveLanguage([tag]), 'en');
  assert.equal(resolveLanguage(['es-CO', 'en-US']), 'es');
  assert.equal(resolveLanguage(['en-US', 'es-CO']), 'en');
  assert.equal(resolveLanguage(['fr-CA', 'en-GB', 'es-CO']), 'en');
  assert.equal(resolveLanguage(['fr-FR', 'es-CO', 'en-GB']), 'es');
});

test('unsupported or missing device languages fall back to Spanish, without a saved override', () => {
  for (const locales of [[], ['fr-FR'], ['pt-BR', 'de-DE'], [''], ['english']]) {
    assert.equal(resolveLanguage(locales), 'es');
    assert.equal(messagesForLocales(locales), messages.es);
  }
  assert.equal(messagesForLocales(['en-US']).actions.signIn, 'Sign in');
  assert.equal(messagesForLocales(['es-CO']).actions.signIn, 'Iniciar sesión');
  assert.equal(messagesForLocales(['en-GB']).headings.authenticated, 'Signed in');
});

test('both catalogs translate every visible state, failure and native credential prompt', () => {
  function compare(spanish: Record<string, unknown>, english: Record<string, unknown>) {
    assert.deepEqual(Object.keys(english).sort(), Object.keys(spanish).sort());
    for (const [key, value] of Object.entries(spanish)) {
      const translated = english[key];
      if (typeof value === 'string') {
        assert.equal(typeof translated, 'string');
        assert.ok(value.trim()); assert.ok(String(translated).trim());
        assert.notEqual(translated, value, `Missing English translation: ${key}`);
      } else {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        assert.ok(translated && typeof translated === 'object' && !Array.isArray(translated));
        compare(value as Record<string, unknown>, translated as Record<string, unknown>);
      }
    }
  }
  compare(messages.es, messages.en);
  const failures: FailureKind[] = ['unavailable', 'unauthorized', 'forbidden', 'invalid_callback', 'invalid_response',
    'cancelled', 'native_required', 'biometric_locked', 'biometric_unavailable', 'biometric_failed', 'logout_unconfirmed'];
  assert.deepEqual(Object.keys(messages.es.failures).sort(), failures.sort());
  assert.match(messages.es.securePrompt, /Confirma tu identidad/);
  assert.match(messages.en.securePrompt, /Confirm your identity/);
});

test('native configuration declares both supported languages and localized Face ID privacy descriptions', () => {
  const { expo } = JSON.parse(readFileSync(new URL('../apps/mobile/app.json', import.meta.url), 'utf8'));
  const plugin = expo.plugins.find((value: unknown) => Array.isArray(value) && value[0] === 'expo-localization');
  assert.deepEqual(plugin[1].supportedLocales, ['es', 'en']);
  assert.equal(expo.ios.infoPlist.CFBundleDevelopmentRegion, 'es');
  assert.match(expo.locales.es.ios.NSFaceIDUsageDescription, /proteger tus credenciales/);
  assert.match(expo.locales.en.ios.NSFaceIDUsageDescription, /protect your sign-in credentials/);
});
