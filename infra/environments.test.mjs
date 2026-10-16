import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations, validateEnvironments, publicOrigins, publicZone } from './environments.mjs';

test('canonical domains remain isolated while legacy web routing stays available', async () => {
  const configs = await configurations();
  assert.doesNotThrow(() => validateEnvironments(configs));
  for (const [environment, origin] of Object.entries(publicOrigins)) {
    assert.deepEqual(configs.web.env[environment].routes, [{ pattern: new URL(origin).hostname, custom_domain: true, zone_id: publicZone }]);
    assert.equal(configs.web.env[environment].workers_dev, true);
    assert.equal(configs['identity-consent-ecosystem'].env[environment].vars.AUTH_REDIRECT_URI, origin + '/auth/callback');
  }
});

test('foreign, wildcard, missing and private domain routes fail before deployment', async () => {
  for (const routes of [[], [{ pattern: 'solventa.site', custom_domain: true }], [{ pattern: '*.solventa.site', custom_domain: true }], [{ pattern: 'dev.solventa.site.attacker.invalid', custom_domain: true }], [{ pattern: 'dev.solventa.site', custom_domain: false }]]) {
    const configs = await configurations();
    configs.web.env.dev.routes = routes.map(route => ({ ...route, zone_id: publicZone }));
    assert.throws(() => validateEnvironments(configs));
  }
  const configs = await configurations();
  configs['identity-consent-ecosystem'].env.dev.routes = [{ pattern: 'identity.solventa.site', custom_domain: true }];
  assert.throws(() => validateEnvironments(configs));
  const wrongZone = await configurations();
  wrongZone.web.env.dev.routes[0].zone_id = '00000000000000000000000000000001';
  assert.throws(() => validateEnvironments(wrongZone));
});

test('auth origins and callbacks cannot drift from the environment domain', async () => {
  for (const [name, value] of [['AUTH_ORIGIN', publicOrigins.prod], ['AUTH_REDIRECT_URI', publicOrigins.dev + '/auth/callback/']]) {
    const configs = await configurations();
    configs['identity-consent-ecosystem'].env.dev.vars[name] = value;
    assert.throws(() => validateEnvironments(configs));
  }
});

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
    configs => { configs['policy-claims-payments'].env.dev.queues.consumers[0].max_batch_timeout = 5; },
  ]) {
    const configs = await configurations();
    mutate(configs);
    assert.throws(() => validateEnvironments(configs));
  }
  validateEnvironments(await configurations());
});
