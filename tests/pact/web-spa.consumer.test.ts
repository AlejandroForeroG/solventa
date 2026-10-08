import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { fetchSession, requestLogout } from '../../apps/web/src/api/auth';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';

const consumerName = 'solventa-web-spa';
const outputDir = pactOutputDir();
const jsonResponse = { 'Content-Type': 'application/json' };
const pact = new PactV3({ consumer: consumerName, provider: providerName, dir: outputDir, logLevel: 'error' });

after(() => assertMatchesCommitted(outputDir, `${consumerName}-${providerName}.json`));

describe('SPA session check', () => {
  test('reports an authenticated session', async () => {
    pact.given('an active session').uponReceiving('a session check with an active session')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { authenticated: true } });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'authenticated'));
  });

  test('reports an anonymous visitor', async () => {
    pact.given('no active session').uponReceiving('a session check without a session')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 401, headers: jsonResponse, body: { authenticated: false } });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'anonymous'));
  });

  test('reports unavailable when authentication is not configured', async () => {
    pact.given('authentication is not configured').uponReceiving('a session check while authentication is unavailable')
      .withRequest({ method: 'GET', path: '/auth/session' })
      .willRespondWith({ status: 503, headers: jsonResponse, body: { error: 'authentication_unavailable' } });
    await pact.executeTest(async server => assert.equal(await fetchSession(server.url), 'unavailable'));
  });
});

describe('SPA logout', () => {
  test('receives the provider logout URL', async () => {
    pact.given('an active session').uponReceiving('a logout with an active session')
      .withRequest({ method: 'POST', path: '/auth/logout' })
      .willRespondWith({ status: 200, headers: jsonResponse, body: { logoutUrl: MatchersV3.regex('^https://.+', 'https://auth.example.invalid/logout') } });
    await pact.executeTest(async server => {
      assert.deepEqual(await requestLogout(server.url), { status: 'redirect', logoutUrl: 'https://auth.example.invalid/logout' });
    });
  });

  test('treats a missing session as already logged out', async () => {
    pact.given('no active session').uponReceiving('a logout without a session')
      .withRequest({ method: 'POST', path: '/auth/logout' })
      .willRespondWith({ status: 401, headers: jsonResponse, body: { authenticated: false } });
    await pact.executeTest(async server => assert.deepEqual(await requestLogout(server.url), { status: 'anonymous' }));
  });
});
