import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mountApiAccess, authorizeApiAccess } from '../backend/identity-consent-ecosystem/src/adapters/inbound/api-access-http';
import { WorkosAuthentication } from '../backend/identity-consent-ecosystem/src/adapters/outbound/workos-authentication';
import { SqlPartnerAccess } from '../backend/identity-consent-ecosystem/src/adapters/outbound/partner-access';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import web from '../apps/web/worker/index';

const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const env = { APP_ENV: 'dev', AUTH_ORIGIN: origin, AUTH_REDIRECT_URI: origin + '/auth/callback', WORKOS_CLIENT_ID: 'client_synthetic', WORKOS_API_KEY: 'sk_synthetic', AUTH_COOKIE_PASSWORD: 'a'.repeat(64), IDENTITY_DB: { connectionString: 'postgresql://synthetic.invalid/unused' }, WORKOS_CONNECT_ISSUER: '', WORKOS_CONNECT_AUDIENCE: '', WEB_CHANNEL_CREDENTIAL_REFERENCE: 'dev:v1' } as IdentityEnv;

test('access probes preserve trace without reflecting an arbitrary header, expose no credential and reject methods', async () => {
  const app = new Hono<{ Bindings: IdentityEnv }>();
  const actor = { kind: 'partner' as const, partnerId: crypto.randomUUID(), credentialId: crypto.randomUUID(), scopes: ['quotes:create'] };
  mountApiAccess(app, async (_env, input) => {
    assert.deepEqual(input, { kind: 'partner', token: 'synthetic.jwt.token', scope: 'quotes:create' });
    return { allowed: true, actor };
  });
  const traceId = crypto.randomUUID();
  const success = await app.request(origin + '/api/v1/access/partner', { headers: { Authorization: 'Bearer synthetic.jwt.token', 'X-Trace-Id': traceId, 'X-Partner-Id': 'untrusted' } }, env);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { actor, traceId });
  assert.equal(success.headers.get('x-trace-id'), traceId);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  const wrongMethod = await app.request(origin + '/api/v1/access/partner', { method: 'POST', headers: { 'X-Trace-Id': 'private-arbitrary-text' } }, env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  assert.notEqual(wrongMethod.headers.get('x-trace-id'), 'private-arbitrary-text');
  assert.equal((await app.request(origin + '/api/v1/access/web', { headers: { Authorization: 'Bearer synthetic.jwt.token' } }, env)).status, 400);
});

test('missing credentials, unavailable M2M config, forged web cookie and mutation CSRF fail closed', async () => {
  const app = new Hono<{ Bindings: IdentityEnv }>();
  mountApiAccess(app);
  const missing = await app.request(origin + '/api/v1/access/partner', {}, env);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="solventa"');
  assert.equal((await app.request(origin + '/api/v1/access/partner', { headers: { Authorization: 'Bearer synthetic.jwt.token' } }, env)).status, 503);
  assert.equal((await app.request(origin + '/api/v1/access/web', {}, env)).status, 401);
  assert.equal((await app.request(origin + '/api/v1/access/web', { headers: { Cookie: '__Host-solventa-session=forged' } }, env)).status, 401);
  assert.deepEqual(await authorizeApiAccess(env, { kind: 'web', cookie: 'forged', origin: 'https://attacker.invalid', method: 'POST', scope: 'quotes:create' }), { allowed: false, error: 'forbidden', status: 403 });
  assert.equal((await authorizeApiAccess(env, { kind: 'partner', token: '', scope: '*' })).status, 400);
  assert.equal((await authorizeApiAccess(env, null)).status, 400);
});

test('business access never refreshes or registers a web session', async t => {
  t.mock.method(WorkosAuthentication.prototype, 'authenticate', async (_cookie: string, refresh: boolean) => {
    assert.equal(refresh, false);
    return null;
  });
  const result = await authorizeApiAccess(env, { kind: 'web', cookie: 'synthetic', origin, method: 'POST', scope: 'quotes:create' });
  assert.deepEqual(result, { allowed: false, error: 'unauthorized', status: 401 });
});

test('gateway forwards only the published probes and handles a failed identity binding', async () => {
  const mockEnv = { IDENTITY: { fetch: async (request: Request) => Response.json({ forwarded: new URL(request.url).pathname }) } } as WebEnv;
  for (const kind of ['partner', 'web']) {
    const response = await web.fetch(new Request(origin + '/api/v1/access/' + kind), mockEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { forwarded: '/api/v1/access/' + kind });
  }
  assert.equal((await web.fetch(new Request(origin + '/api/v1/quotes'), mockEnv)).status, 404);
  const unavailable = await web.fetch(new Request(origin + '/api/v1/access/partner'), { IDENTITY: { fetch: async () => { throw Error('private detail'); } } } as WebEnv);
  assert.equal(unavailable.status, 503);
  const body = await unavailable.json() as { error: string; traceId: string };
  assert.equal(body.error, 'access_unavailable');
  assert.equal(body.traceId, unavailable.headers.get('x-trace-id'));
});

test('web authorization selects the channel from server configuration and ignores supplied actor identifiers', async t => {
  t.mock.method(WorkosAuthentication.prototype, 'authenticate', async () => ({ identity: { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true } }));
  const principal = { clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() };
  const credential = { partnerId: crypto.randomUUID(), credentialId: crypto.randomUUID(), scopes: ['quotes:create'] };
  t.mock.method(SqlIdentitySessions.prototype, 'find', async () => principal);
  t.mock.method(SqlPartnerAccess.prototype, 'find', async (provider: string, reference: string) => {
    assert.equal(provider, 'solventa-web');
    assert.equal(reference, 'dev:v1');
    return credential;
  });
  const decision = await authorizeApiAccess(env, { kind: 'web', cookie: 'synthetic', origin, method: 'POST', scope: 'quotes:create', channelReference: 'dev:attacker', partnerId: 'forged', clientId: 'forged' });
  assert.deepEqual(decision, { allowed: true, actor: { ...credential, kind: 'web', principal } });
});
