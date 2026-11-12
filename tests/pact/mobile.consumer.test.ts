import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { createSessionApi } from '../../apps/mobile/src/features/authentication/adapters/solventa-session';
import { createAssistanceApi } from '../../apps/mobile/src/features/assistance/adapters/assistance-api';
import { createPoliciesApi } from '../../apps/mobile/src/features/policy-wallet/adapters/policies-api';
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

test('mobile lists its own issued policies through the public gateway', async () => {
  const policy = { policyId: '30000000-0000-4000-8000-000000000003', product: 'vida_hipotecario', status: 'issued', premium: '77760.0000', currency: 'COP',
    effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveUntil: '2027-10-15T00:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' } };
  pact.given('a native session with an issued policy').uponReceiving('mobile own policy list')
    .withRequest({ method: 'GET', path: '/api/v1/policies', headers: { Authorization: 'Bearer synthetic.jwt.token', Accept: 'application/json' } })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { policies: [policy], hasMore: false, traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    const api = createPoliciesApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') }, (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
    const { status: _status, ...kept } = policy;
    assert.deepEqual(await api.list(), { policies: [kept], hasMore: false });
  });
});

test('mobile finds a simulated provider through the shared search contract', async () => {
  const provider = { id: 'demo-med-roadside', kind: 'roadside', name: 'Asistencia de prueba Medellín', city: 'Medellín',
    address: 'Calle de prueba 30', phone: '+570000000003', hours: 'Todos los días 00:00–24:00' };
  const input = { kind: 'manual', query: 'Medellín' } as const;
  pact.given('a native session with access to the synthetic assistance directory').uponReceiving('mobile assistance provider search')
    .withRequest({ method: 'POST', path: '/api/v1/assistance/providers/search',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer synthetic.jwt.token' }, body: input })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' },
      body: { simulated: true, providers: [provider], traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    const api = createAssistanceApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
      (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
    assert.deepEqual(await api.search(input), [provider]);
  });
});

const assistanceProvider = { id: 'demo-bog-workshop', kind: 'workshop', name: 'Taller de prueba Bogotá', city: 'Bogotá',
  address: 'Calle de prueba 10', phone: '+570000000001', hours: 'Lun–vie 08:00–17:00' };
const assistancePlace = { kind: 'address', address: 'Calle de prueba 10, Bogotá' } as const;
const requestBody = { providerId: assistanceProvider.id, place: assistancePlace };
// The identity, the reference and the date are the store's to choose: the contract fixes their shape, not their value.
const storedRequest = {
  id: MatchersV3.uuid('40000000-0000-4000-8000-000000000001'), reference: MatchersV3.regex('^ASI-[0-9A-HJKMNP-TV-Z]{8}$', 'ASI-22222221'), status: 'requested',
  provider: assistanceProvider, place: assistancePlace,
  createdAt: MatchersV3.regex('^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$', '2026-11-12T22:30:00.000Z'),
};
const storedView = { id: '40000000-0000-4000-8000-000000000001', reference: 'ASI-22222221', status: 'requested', provider: assistanceProvider, place: assistancePlace, createdAt: '2026-11-12T22:30:00.000Z' };

test('mobile requests assistance from a provider and gets the stored request through the shared contract', async () => {
  pact.given('a native session that may request assistance').uponReceiving('mobile assistance request')
    .withRequest({ method: 'POST', path: '/api/v1/assistance/requests',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer synthetic.jwt.token', 'Idempotency-Key': 'pact-request-key-0001' }, body: requestBody })
    .willRespondWith({ status: 201, headers: { 'Content-Type': 'application/json' },
      body: { simulated: true, request: storedRequest, traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    const api = createAssistanceApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
      (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
    assert.deepEqual(await api.createRequest(requestBody, 'pact-request-key-0001'), storedView);
  });
});

test('mobile reads its own assistance requests through the shared contract', async () => {
  pact.given('a native session with a stored assistance request').uponReceiving('mobile own assistance requests')
    .withRequest({ method: 'GET', path: '/api/v1/assistance/requests', headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' },
      body: { simulated: true, requests: [storedRequest], traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    const api = createAssistanceApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
      (url, options) => fetch(`${server.url}${new URL(String(url)).pathname}`, options));
    assert.deepEqual(await api.listRequests(), [storedView]);
  });
});
