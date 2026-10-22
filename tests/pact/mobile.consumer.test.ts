import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { createSessionApi } from '../../apps/mobile/src/features/authentication/adapters/solventa-session';
import { createVerificationApi } from '../../apps/mobile/src/features/identity-verification/adapters/verification-api';
import type { VerificationCommand } from '../../apps/mobile/src/features/identity-verification/application/ports';
import examples from '../../packages/contracts/examples/identity-verifications.json';
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

for (const stage of ['empty', 'draft', 'ready', 'not_verified', 'unavailable', 'approved', 'assistance', 'revoked', 'expired'] as const) {
  test(`mobile resumes native verification in ${stage} state`, async () => {
    pact.given(`a native identity verification in ${stage} state`).uponReceiving(`mobile current verification ${stage}`)
      .withRequest({ method: 'GET', path: '/api/v1/mobile/identity-verifications', headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } })
      .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { verification: examples.cases[stage], traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
        (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
      assert.deepEqual(await api.current(), examples.cases[stage]);
    });
  });
}
for (const language of ['es', 'en'] as const) {
  const locale = language === 'es' ? 'es-CO' : 'en-US';
  test(`mobile reads explicit verification terms in ${locale}`, async () => {
    pact.given('a native identity verification in empty state').uponReceiving(`mobile identity terms ${locale}`)
      .withRequest({ method: 'GET', path: '/api/v1/mobile/identity-verifications/terms', query: { locale }, headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } })
      .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { terms: examples.terms[language], traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
        (url, options) => { const source = new URL(String(url)); return fetch(`${server.url}${source.pathname}${source.search}`, options); });
      assert.deepEqual(await api.terms(locale), examples.terms[language]);
    });
  });
}
test('mobile reads only the versioned synthetic verification fixtures', async () => {
  pact.given('a native identity verification in empty state').uponReceiving('mobile identity fixture corpus')
    .withRequest({ method: 'GET', path: '/api/v1/mobile/identity-verifications/fixtures', headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { fixtures: examples.fixtures, traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
      (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
    assert.deepEqual(await api.fixtures(), examples.fixtures);
  });
});

const verificationId = examples.cases.draft.id;
const document = examples.fixtures.find(item => item.reference === 'document-readable')!;
const commands: { name: string; state: string; command: VerificationCommand; status: number; expected: object }[] = [
  { name: 'explicit grant', state: 'empty', command: { action: 'grant', body: { textVersion: 1, locale: 'es-CO' } }, status: 201, expected: examples.cases.draft },
  { name: 'document selection', state: 'draft', command: { action: 'step', id: verificationId, step: 'document', body: {
    reference: document.reference, sha256: document.sha256, corpusVersion: 'synthetic-identity.v1', expectedVersion: 1 } }, status: 200,
    expected: { ...examples.cases.draft, version: 2, steps: [{ reference: document.reference, sha256: document.sha256, corpusVersion: document.corpusVersion, step: 'document' }] } },
  { name: 'evaluation', state: 'ready', command: { action: 'evaluate', id: verificationId, body: { expectedVersion: 4 } }, status: 200, expected: examples.cases.approved },
  { name: 'assisted request', state: 'not_verified', command: { action: 'assistance', id: verificationId, body: { expectedVersion: 6 } }, status: 200, expected: examples.cases.assistance },
  { name: 'consent revocation', state: 'ready', command: { action: 'revoke', id: verificationId, body: {} }, status: 200, expected: examples.cases.revoked },
];
for (const { name, state, command, status, expected } of commands) {
  test(`mobile identity ${name} uses the real consumer adapter`, async () => {
    const path = command.action === 'grant' ? '' : command.action === 'step' ? `/${command.id}/steps/${command.step}` : `/${command.id}/${command.action}`;
    pact.given(`a native identity verification in ${state} state`).uponReceiving(`mobile identity ${name}`)
      .withRequest({ method: command.action === 'step' ? 'PUT' : 'POST', path: `/api/v1/mobile/identity-verifications${path}`,
        headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token', 'Content-Type': 'application/json', 'Idempotency-Key': 'consumer-request' }, body: command.body })
      .willRespondWith({ status, headers: { 'Content-Type': 'application/json' }, body: { verification: expected, traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
        (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
      assert.deepEqual(await api.execute(command, 'consumer-request'), expected);
    });
  });
}
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
