import assert from 'node:assert/strict';

export function financialSecrets(environment, value) {
  assert.ok(['dev', 'staging', 'prod'].includes(environment));
  if (!value) return { FINANCIAL_EVENT_KEY: '' };
  assert.notEqual(environment, 'prod', 'Mock financial configuration cannot be enabled in production');
  const config = JSON.parse(value);
  assert.deepEqual(Object.keys(config).sort(), ['environment', 'secrets']);
  assert.equal(config.environment, environment);
  assert.deepEqual(Object.keys(config.secrets), ['FINANCIAL_EVENT_KEY']);
  assert.match(config.secrets.FINANCIAL_EVENT_KEY, /^[a-f0-9]{64}$/);
  return { FINANCIAL_EVENT_KEY: config.secrets.FINANCIAL_EVENT_KEY };
}
