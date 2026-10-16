import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const remoteEnvironments = ['dev', 'staging', 'prod'];
export const publicOrigins = Object.freeze({ dev: 'https://dev.solventa.site', staging: 'https://staging.solventa.site', prod: 'https://solventa.site' });
export const legacyOrigins = Object.freeze(Object.fromEntries(remoteEnvironments.map(environment => [environment, `https://solventa-web-${environment}.ja-forerog1.workers.dev`])));
export const account = '803fd559877aae8f638140610f106857';
export const publicZone = 'a750d13e4cc496c6f26671cf1e8ad099';
const zero = '00000000000000000000000000000000';
const services = [
  { name: 'acquisition-risk', binding: 'ACQUISITION_DB' },
  { name: 'identity-consent-ecosystem', binding: 'IDENTITY_DB' },
  { name: 'policy-claims-payments', binding: 'POLICY_DB' },
];

export async function configurations() {
  return Object.fromEntries(await Promise.all([...services.map(s => s.name), 'web'].map(async name => [name,
    JSON.parse(await readFile(name === 'web' ? 'apps/web/wrangler.jsonc' : `backend/${name}/wrangler.jsonc`, 'utf8')),
  ])));
}

// Fail before provisioning or deploying if a binding points across environment boundaries.
export function validateEnvironments(configs, provisionedEnvironment) {
  const ids = new Set();
  for (const environment of remoteEnvironments) {
    for (const [name, config] of Object.entries(configs)) {
      assert.equal(config.account_id, account);
      const target = config.env[environment];
      assert.equal(target.name, `solventa-${name}-${environment}`);
      assert.equal(target.vars.APP_ENV, environment);
      assert.equal(target.preview_urls, false);
      assert.equal(target.workers_dev, name === 'web');
      assert.deepEqual(target.routes ?? [], name === 'web' ? [{ pattern: new URL(publicOrigins[environment]).hostname, custom_domain: true, zone_id: publicZone }] : []);
      if (name === 'identity-consent-ecosystem') {
        assert.equal(target.vars.AUTH_ORIGIN, publicOrigins[environment]);
        assert.equal(target.vars.AUTH_REDIRECT_URI, publicOrigins[environment] + '/auth/callback');
      }
      const expectedServices = name === 'web' ? [
        { binding: 'ACQUISITION', service: `solventa-acquisition-risk-${environment}` },
        { binding: 'IDENTITY', service: `solventa-identity-consent-ecosystem-${environment}` },
        { binding: 'POLICY', service: `solventa-policy-claims-payments-${environment}` },
      ] : ['acquisition-risk', 'policy-claims-payments'].includes(name) ? [
        { binding: 'IDENTITY_SERVICE', service: `solventa-identity-consent-ecosystem-${environment}` },
      ] : [];
      assert.deepEqual(target.services ?? [], expectedServices);
      if (['acquisition-risk', 'policy-claims-payments'].includes(name)) {
        assert.equal(target.vars.FINANCIAL_PROVIDER_MODE, environment === 'prod' ? 'disabled' : 'mock');
        const queues = target.queues ?? {};
        if (name === 'acquisition-risk') {
          assert.deepEqual(queues.producers ?? [], environment === 'prod' ? [] : [
            { binding: 'FINANCIAL_EVENTS', queue: `solventa-financial-events-${environment}` },
          ]);
        } else {
          const consumers = queues.consumers ?? [];
          assert.equal(consumers.length, environment === 'prod' ? 0 : 1);
          if (environment !== 'prod') {
            assert.equal(consumers[0].queue, `solventa-financial-events-${environment}`);
            assert.equal(consumers[0].dead_letter_queue, `solventa-financial-events-dlq-${environment}`);
            assert.equal(consumers[0].max_retries, 5);
            assert.equal(consumers[0].max_batch_size, 10);
          }
        }
      }
      if (name === 'web') {
        assert.deepEqual(target.secrets.required, ['DEV_INFRA_TOKEN']);
      } else {
        const binding = services.find(s => s.name === name).binding;
        assert.equal(target.hyperdrive.length, 1);
        assert.equal(target.hyperdrive[0].binding, binding);
        const id = target.hyperdrive[0].id;
        assert.match(id, /^[a-f0-9]{32}$/);
        if (id === zero) {
          assert.notEqual(environment, provisionedEnvironment, 'Provision this environment before deploying');
        } else {
          assert.ok(!ids.has(id), 'Hyperdrive cannot be shared across backends or environments');
          ids.add(id);
        }
      }
    }
  }
}
