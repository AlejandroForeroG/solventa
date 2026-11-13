import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { createSessionApi } from '../../apps/mobile/src/features/authentication/adapters/solventa-session';
import { createAssistanceApi } from '../../apps/mobile/src/features/assistance/adapters/assistance-api';
import { createClaimReportApi, type EvidenceUploader } from '../../apps/mobile/src/features/claim-report/adapters/claim-report-api';
import { claimIds, evidenceBytes, evidenceFile, idempotencyKey, manifest } from './support/claim-report-contract';
import { createPoliciesApi } from '../../apps/mobile/src/features/policy-wallet/adapters/policies-api';
import { createVerificationApi } from '../../apps/mobile/src/features/identity-verification/adapters/verification-api';
import { createDraftApi } from '../../apps/mobile/src/features/claim-drafts/adapters/draft-api';
import { DraftFailure } from '../../apps/mobile/src/features/claim-drafts/domain/draft';
import draftExamples from '../../packages/contracts/examples/claim-drafts.json';
import { draftCommand, draftConflict, draftVersion } from './support/claim-drafts';
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

const draftClient = (server: { url: string }) => createDraftApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') },
  (url, options) => { const parsed = new URL(String(url)); return fetch(`${server.url}${parsed.pathname}${parsed.search}`, options); });
for (const operation of ['list', 'get', 'evidence'] as const) {
  test(`mobile claim draft ${operation} follows the owned draft contract`, async () => {
    const path = '/api/v1/claim-drafts' + (operation === 'get' ? `/${draftExamples.draftId}` : operation === 'evidence' ? '/evidence' : '');
    const body = operation === 'get' ? draftVersion : operation === 'list' ? { drafts: [draftVersion] } : { evidence: [] };
    pact.given('native claim drafts ready').uponReceiving(`mobile claim drafts ${operation}`)
      .withRequest({ method: 'GET', path, ...(operation === 'evidence' ? { query: { policyId: draftCommand.content.policyId } } : {}),
        headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } })
      .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { ...body, traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const api = draftClient(server);
      assert.deepEqual(operation === 'list' ? await api.list() : operation === 'get' ? await api.get(draftExamples.draftId) : await api.evidence(draftCommand.content.policyId),
        operation === 'list' ? [draftVersion] : operation === 'get' ? draftVersion : []);
    });
  });
}
for (const mode of ['ready', 'conflict', 'resolved', 'unavailable'] as const) {
  test(`mobile claim draft synchronization in ${mode} state uses the real adapter`, async () => {
    const command = mode === 'resolved' ? { ...draftCommand, commandId: '30000000-0000-4000-8000-000000000013', baseRevision: 2,
      resolution: { conflictId: draftCommand.commandId, keep: 'local' as const } } : draftCommand;
    const body = mode === 'conflict' ? { status: 'conflict', conflict: draftConflict }
      : mode === 'unavailable' ? { error: 'service_unavailable' } : { status: 'confirmed', merged: false, draft: { ...draftVersion, revision: 2, content: command.content } };
    pact.given(`native claim drafts ${mode}`).uponReceiving(`mobile claim draft sync ${mode}`)
      .withRequest({ method: 'PUT', path: `/api/v1/claim-drafts/${draftExamples.draftId}`, body: command,
        headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token', 'Content-Type': 'application/json' } })
      .willRespondWith({ status: mode === 'conflict' ? 409 : mode === 'unavailable' ? 503 : 200,
        headers: { 'Content-Type': 'application/json' }, body: { ...body, traceId: MatchersV3.uuid(traceId) } });
    await pact.executeTest(async server => {
      const result = draftClient(server).sync(draftExamples.draftId, command);
      if (mode === 'unavailable') await assert.rejects(result, (error: unknown) => error instanceof DraftFailure && error.kind === 'unavailable');
      else assert.deepEqual(await result, body);
    });
  });
}

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

const reportSession = { execute: <T>(operation: (token: string) => Promise<T>) => operation('synthetic.jwt.token') };
const reportApi = (serverUrl: string, uploader: EvidenceUploader = async () => ({ status: 500, body: '' })) =>
  createClaimReportApi(baseUrl, reportSession, uploader, (url, options) => fetch(`${serverUrl}${new URL(String(url)).pathname}`, options));

test('mobile declares a claim report and gets the draft through the shared contract', async () => {
  pact.given('a native session that may report a claim').uponReceiving('mobile claim report draft')
    .withRequest({ method: 'POST', path: '/api/v1/claims',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer synthetic.jwt.token', 'Idempotency-Key': idempotencyKey }, body: manifest })
    .willRespondWith({ status: 201, headers: { 'Content-Type': 'application/json' },
      body: { claimId: MatchersV3.uuid(claimIds.claim), state: 'draft', evidence: [{ fileId: claimIds.file, state: 'pending' }], traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    assert.deepEqual(await reportApi(server.url).createDraft(manifest, idempotencyKey), { claimId: claimIds.claim, evidence: [{ fileId: claimIds.file, state: 'pending' }] });
  });
});

test('mobile uploads the file of a draft and gets it verified through the shared contract', async () => {
  pact.given('a native session with a draft claim report').uponReceiving('mobile claim report evidence')
    .withRequestBinaryFile({ method: 'PUT', path: `/api/v1/claims/${claimIds.claim}/evidence/${claimIds.file}`,
      headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } }, 'image/jpeg', evidenceFile)
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' },
      body: { fileId: claimIds.file, state: 'verified', traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    // The native layer streams the file from its path; this stand-in sends the same bytes with the same headers over HTTP.
    const uploader: EvidenceUploader = async ({ url, contentType, token }) => {
      const response = await fetch(`${server.url}${new URL(url).pathname}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, Accept: 'application/json' }, body: evidenceBytes });
      return { status: response.status, body: await response.text() };
    };
    await reportApi(server.url, uploader).upload(claimIds.claim, { id: claimIds.file, uri: 'file:///cache/evidence.jpg', contentType: 'image/jpeg', byteSize: evidenceBytes.length, kind: 'photo' });
  });
});

test('mobile submits a claim report whose files were received and gets its single case number', async () => {
  pact.given('a native session with a claim report whose evidence was received').uponReceiving('mobile claim report submission')
    .withRequest({ method: 'POST', path: `/api/v1/claims/${claimIds.claim}/submit`, headers: { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' } })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json' },
      body: { claimId: claimIds.claim, claimNumber: MatchersV3.regex('^SIN-[0-9]{4}-[0-9]{5}$', 'SIN-2026-00001'), state: 'unassigned',
        submittedAt: MatchersV3.regex('^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$', '2026-11-11T00:00:00.000Z'), traceId: MatchersV3.uuid(traceId) } });
  await pact.executeTest(async server => {
    const receipt = await reportApi(server.url).submit(claimIds.claim);
    assert.deepEqual(receipt, { claimId: claimIds.claim, claimNumber: 'SIN-2026-00001', submittedAt: '2026-11-11T00:00:00.000Z' });
  });
});
