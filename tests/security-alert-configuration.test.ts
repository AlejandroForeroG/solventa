import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityEmailConfiguration } from '../backend/identity-consent-ecosystem/src/adapters/outbound/security-alert-configuration';

test('absent email configuration leaves publication disabled', () => {
  assert.equal(securityEmailConfiguration(undefined, 'dev'), null);
  assert.equal(securityEmailConfiguration('', 'dev'), null);
});

test('email configuration is bound to the intended environment and contains only delivery addresses', () => {
  const configured = { environment: 'dev', from: 'security@sender.example', to: 'operator@example.test' };
  assert.deepEqual(securityEmailConfiguration(JSON.stringify(configured), 'dev'), configured);
  assert.throws(() => securityEmailConfiguration(JSON.stringify(configured), 'prod'), { message: 'invalid_security_alert_email_configuration' });
  for (const value of ['{invalid', 'null', '[]', '{}', JSON.stringify({ ...configured, extra: 'discard' }), JSON.stringify({ ...configured, from: null })]) {
    assert.throws(() => securityEmailConfiguration(value, 'dev'), { message: 'invalid_security_alert_email_configuration' });
  }
});
