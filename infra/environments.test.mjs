import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations, validateEnvironments } from './environments.mjs';

test('a staging consumer cannot call a production backend', async () => {
  const configs = await configurations();
  configs.web.env.staging.services[0].service = 'solventa-acquisition-risk-prod';
  assert.throws(() => validateEnvironments(configs));
});

test('an acquisition Worker cannot call identity in another environment', async () => {
  const configs = await configurations();
  configs['acquisition-risk'].env.prod.services[0].service = 'solventa-identity-consent-ecosystem-dev';
  assert.throws(() => validateEnvironments(configs));
});

test('a database binding cannot be reused across environments', async () => {
  const configs = await configurations();
  const acquisition = configs['acquisition-risk'];
  acquisition.env.staging.hyperdrive[0].id = acquisition.env.dev.hyperdrive[0].id;
  assert.throws(() => validateEnvironments(configs));
});

test('an unprovisioned environment cannot deploy through automatic provisioning', async () => {
  const configs = await configurations();
  configs['identity-consent-ecosystem'].env.prod.hyperdrive[0].id = '00000000000000000000000000000000';
  assert.throws(() => validateEnvironments(configs, 'prod'));
});

test('private backends cannot enable a public preview', async () => {
  const configs = await configurations();
  configs['policy-claims-payments'].env.prod.preview_urls = true;
  assert.throws(() => validateEnvironments(configs));
});

test('financial consumers and signatures stay within the selected environment', async () => {
  for (const mutate of [
    configs => { configs['policy-claims-payments'].env.dev.services[0].service = 'solventa-identity-consent-ecosystem-prod'; },
    configs => { configs['acquisition-risk'].env.staging.queues.producers[0].queue = 'solventa-financial-events-dev'; },
    configs => { configs['policy-claims-payments'].env.staging.queues.consumers[0].dead_letter_queue = 'solventa-financial-events-dlq-dev'; },
    configs => { configs['policy-claims-payments'].env.prod.vars.FINANCIAL_PROVIDER_MODE = 'mock'; },
  ]) {
    const configs = await configurations();
    mutate(configs);
    assert.throws(() => validateEnvironments(configs));
  }
  validateEnvironments(await configurations());
});
