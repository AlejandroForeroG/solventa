import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const remoteEnvironments = ['dev', 'staging', 'prod'];
export const account = '803fd559877aae8f638140610f106857';
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
      const expectedServices = name === 'web' ? [
        { binding: 'ACQUISITION', service: `solventa-acquisition-risk-${environment}` },
        { binding: 'IDENTITY', service: `solventa-identity-consent-ecosystem-${environment}` },
        { binding: 'POLICY', service: `solventa-policy-claims-payments-${environment}` },
      ] : name === 'acquisition-risk' ? [
        { binding: 'IDENTITY_SERVICE', service: `solventa-identity-consent-ecosystem-${environment}` },
      ] : [];
      assert.deepEqual(target.services ?? [], expectedServices);
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
