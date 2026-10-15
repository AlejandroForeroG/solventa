import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { createSessionApi } from '../../apps/mobile/src/features/authentication/adapters/solventa-session';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';

const consumer = 'solventa-mobile';
const output = pactOutputDir();
const pact = new PactV3({ consumer, provider: providerName, dir: output, logLevel: 'error' });
const installationId = '00000000-0000-4000-8000-000000000003';
const id = '00000000-0000-4000-8000-000000000001';
const traceId = '00000000-0000-4000-8000-000000000002';
after(() => assertMatchesCommitted(output, `${consumer}-${providerName}.json`));

const baseUrl = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const configuration = { clientId: 'client_01M47F52THNNZZZ4WSGACX8KA4', redirectUri: 'solventa://auth/callback',
  authorizationEndpoint: 'https://api.workos.com/user_management/authorize', tokenEndpoint: 'https://api.workos.com/user_management/authenticate' };
const principal = { clientId: id, subjectToken: traceId };
for (const operation of ['configuration', 'register', 'inspect', 'access', 'logout'] as const) {
  test(`mobile ${operation} agrees with the public gateway`, async () => {
    const path = operation === 'configuration' ? '/mobile/config' : operation === 'access' ? '/access/mobile' : '/mobile/session';
    const method = operation === 'register' ? 'POST' : operation === 'logout' ? 'DELETE' : 'GET';
    const body = operation === 'configuration' ? configuration : operation === 'access'
      ? { actor: { kind: 'user', channel: 'mobile', principal, operations: ['quotes:create'] } }
      : operation === 'logout' ? { status: 'signed_out' } : { principal, channel: 'mobile' };
    pact.given('a native session with its installation binding').uponReceiving(`mobile ${operation}`)
      .withRequest({ method, path: `/api/v1${path}`, headers: { Accept: 'application/json',
        ...(operation === 'configuration' ? {} : { Authorization: 'Bearer synthetic.jwt.token' }) } })
      .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { ...body, traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const api = createSessionApi(baseUrl, (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
      const result = await api[operation]('synthetic.jwt.token');
      if (operation === 'configuration') assert.deepEqual(result, configuration);
      else if (operation !== 'logout') assert.deepEqual(result, principal);
    });
  });
}

for (const method of ['POST', 'GET', 'DELETE'] as const) {
  test(`mobile ${method} device lifecycle agrees with the public gateway`, async () => {
    pact.given('a native session with its installation binding').uponReceiving(`mobile device ${method}`)
      .withRequest({ method, path: `/api/v1/mobile/devices/${installationId}`, headers: { Authorization: 'Bearer synthetic.jwt.token', Accept: 'application/json' } })
      .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' },
        body: { device: { id, installationId, status: method === 'DELETE' ? 'revoked' : 'active' }, traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const api = createSessionApi('https://solventa-web-dev.ja-forerog1.workers.dev', (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
      if (method === 'POST') await api.registerDevice('synthetic.jwt.token', installationId);
      else if (method === 'GET') await api.inspectDevice('synthetic.jwt.token', installationId);
      else await api.revokeDevice('synthetic.jwt.token', installationId);
    });
  });
}
