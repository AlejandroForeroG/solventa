import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { SecurityDecisions } from '../backend/identity-consent-ecosystem/src/application/security-decisions';
import type { SecurityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';
import { ANA, LUIS, TRACE, SEAL_KEY, MemoryConsents, clock } from './support/consent-fakes';

async function setup(failing = false) {
  const decisions: SecurityDecision[] = [];
  const store = new MemoryConsents();
  const security = new SecurityDecisions({ append: async decision => { if (failing) throw Error('synthetic audit unavailable'); decisions.push(decision); } }, () => '60000000-0000-4000-8000-000000000001');
  const consents = new Consents({ store, integrity: new HmacIntegrity(SEAL_KEY), platform: clock(), security });
  const granted = await consents.grant({ principal: ANA, body: { textVersion: 2, locale: 'es-CO' }, idempotencyKey: 'synthetic-grant', traceId: TRACE });
  assert.equal(granted.status, 'created');
  assert.ok('consent' in granted);
  const http = createHttp({ consents, authorizeApiAccess: async () => ({ allowed: true, actor: { kind: 'user', channel: 'web', principal: LUIS, operations: ['consents:read', 'consents:write'] } }) });
  const request = (path: string, method = 'GET') => http.request('https://web.example/api/v1/consents' + path, { method, headers: { 'x-trace-id': TRACE }, ...(method === 'POST' ? { body: '{}' } : {}) }, { APP_ENV: 'local' } as IdentityEnv);
  return { consents, request, decisions, consentId: granted.consent.consentId };
}

test('foreign or absent revocation remains opaque 404 and records no actor or resource identifiers', async () => {
  const { request, decisions, consentId } = await setup();
  const response = await request(`/${consentId}/revoke`, 'POST');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found', traceId: TRACE });
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0], { schemaVersion: 1, decisionId: '60000000-0000-4000-8000-000000000001', correlationId: TRACE, category: 'api_access', channel: 'web', operation: 'consents:write', cause: 'forbidden' });
});

test('a foreign cursor records a denial while ordinary empty lists and exhausted owned pages do not', async () => {
  const { request, decisions, consentId, consents } = await setup();
  assert.equal((await request('')).status, 200);
  assert.equal(decisions.length, 0);
  assert.deepEqual(await consents.list(ANA, consentId, TRACE), { items: [], nextCursor: null });
  assert.equal(decisions.length, 0);
  const response = await request(`?after=${consentId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], nextCursor: null, traceId: TRACE });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].operation, 'consents:read');
});

test('failed consent resource denial persistence returns correlated 503 instead of 404 or an empty success', async () => {
  const { request, consentId } = await setup(true);
  for (const [path, method] of [[`/${consentId}/revoke`, 'POST'], [`?after=${consentId}`, 'GET']] as const) {
    const response = await request(path, method);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId: TRACE });
  }
});
