import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { MobileSessions } from '../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import { unexpectedAuthentication } from './support/authentication-fakes';
import worker from '../apps/web/worker/index';

const spec = parse(readFileSync('packages/contracts/openapi/v1/mobile-authentication.yaml', 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: 'https://solventa.test/mobile.yaml' });
const identity = { providerSubject: 'user_synthetic', sessionReference: 'session_synthetic', emailVerified: true };
const principal = { clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() };
const actor = { kind: 'user', channel: 'mobile', principal, operations: ['quotes:create'] } as const;
const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const headers = { Authorization: 'Bearer synthetic.jwt.token', 'X-Trace-Id': crypto.randomUUID() };
const env = { APP_ENV: 'dev' } as IdentityEnv;
function setup(options: { verified?: boolean; registered?: boolean; unavailable?: boolean; revokeUnavailable?: boolean } = {}) {
  const calls: string[] = [];
  let active = options.registered ?? false;
  let revoked = false;
  const app = createHttp({ authentication: unexpectedAuthentication,
    authorizeApiAccess: async input => {
      calls.push('authorize');
      assert.deepEqual(input, { kind: 'mobile', token: 'synthetic.jwt.token', operation: 'quotes:create' });
      return active ? { allowed: true, actor } : { allowed: false, error: 'unauthorized', status: 401 };
    },
    mobile: {
      configuration: { clientId: 'client_synthetic', redirectUri: 'solventa://auth/callback' },
      provider: {
        authenticate: async () => { calls.push('verify'); if (options.unavailable) throw new Error('provider_offline'); return options.verified === false ? null : identity; },
        revoke: async () => { calls.push('provider_revoke'); if (options.revokeUnavailable) throw new Error('offline'); },
      },
      sessions: new MobileSessions({
        register: async () => { calls.push('register'); if (revoked) return null; active = true; return principal; },
        find: async () => { calls.push('find'); return active ? principal : null; },
        revoke: async () => { calls.push('local_revoke'); active = false; revoked = true; },
      }),
    },
  });
  return { calls, request: (path: string, method = 'GET', supplied = headers) => app.request(origin + '/api/v1' + path, { method, headers: supplied }, env) };
}
async function contract(path: string, method: string, response: Response, name: string, status: number) {
  assert.equal(response.status, status);
  assert.ok(spec.paths[path][method.toLowerCase()].responses[String(status)]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(response.headers.get('x-trace-id'), body.traceId);
  const validate = ajv.getSchema(`https://solventa.test/mobile.yaml#/components/schemas/${name}`);
  assert.ok(validate);
  assert.ok(validate(body), JSON.stringify(validate.errors));
  return body;
}
test('public configuration exposes only public environment configuration without authentication or persistence', async () => {
  const flow = setup();
  const body = await contract('/mobile/config', 'GET', await flow.request('/mobile/config'), 'Configuration', 200);
  assert.equal(body.clientId, 'client_synthetic');
  assert.deepEqual(flow.calls, []);
});
test('native bootstrap, active retry, inspection, permission probe and logout follow the documented contract', async () => {
  const flow = setup();
  await contract('/mobile/session', 'GET', await flow.request('/mobile/session'), 'Error', 401);
  for (let retry = 0; retry < 2; retry++) {
    const body = await contract('/mobile/session', 'POST', await flow.request('/mobile/session', 'POST'), 'Session', 200);
    assert.deepEqual(body.principal, principal);
  }
  await contract('/mobile/session', 'GET', await flow.request('/mobile/session'), 'Session', 200);
  await contract('/access/mobile', 'GET', await flow.request('/access/mobile'), 'Access', 200);
  await contract('/mobile/session', 'DELETE', await flow.request('/mobile/session', 'DELETE'), 'Logout', 200);
  assert.deepEqual(flow.calls.slice(-4), ['verify', 'register', 'local_revoke', 'provider_revoke']);
  await contract('/mobile/session', 'GET', await flow.request('/mobile/session'), 'Error', 401);
  await contract('/mobile/session', 'POST', await flow.request('/mobile/session', 'POST'), 'Error', 401);
  await contract('/access/mobile', 'GET', await flow.request('/access/mobile'), 'Error', 401);
});
test('native endpoints reject missing credentials, malformed headers and web cookies before reaching collaborators', async () => {
  for (const path of ['/mobile/session', '/access/mobile']) {
    for (const [supplied, status] of [[{}, 401], [{ Authorization: 'Basic synthetic' }, 401], [{ ...headers, Cookie: '__Host-solventa-session=sealed' }, 400]] as const) {
      const flow = setup();
      await contract(path, 'GET', await flow.request(path, 'GET', supplied), 'Error', status);
      assert.deepEqual(flow.calls, []);
    }
  }
});
test('unverified user and provider outages return documented denials without registration', async () => {
  for (const [options, status] of [[{ verified: false }, 401], [{ unavailable: true }, 503]] as const) {
    const flow = setup(options);
    await contract('/mobile/session', 'POST', await flow.request('/mobile/session', 'POST'), 'Error', status);
    assert.deepEqual(flow.calls, ['verify']);
  }
});
test('provider logout failure returns unavailable after durable local revocation; replay cannot reopen the session', async () => {
  const flow = setup({ registered: true, revokeUnavailable: true });
  await contract('/mobile/session', 'DELETE', await flow.request('/mobile/session', 'DELETE'), 'Error', 503);
  assert.deepEqual(flow.calls, ['verify', 'register', 'local_revoke', 'provider_revoke']);
  await contract('/mobile/session', 'POST', await flow.request('/mobile/session', 'POST'), 'Error', 401);
});
test('logout before the first bootstrap leaves a revoked local reference and prevents later registration', async () => {
  const flow = setup();
  await contract('/mobile/session', 'DELETE', await flow.request('/mobile/session', 'DELETE'), 'Logout', 200);
  await contract('/mobile/session', 'POST', await flow.request('/mobile/session', 'POST'), 'Error', 401);
});
test('unsupported methods and unavailable mobile configuration answer normalized errors', async () => {
  const flow = setup();
  const method = await flow.request('/mobile/session', 'PUT');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, POST, DELETE');
  assert.deepEqual(flow.calls, []);
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => { throw new Error('unexpected'); } });
  await contract('/mobile/config', 'GET', await app.request(origin + '/api/v1/mobile/config', {}, env), 'Error', 503);
});
test('gateway forwards native routes through Identity after the version gate, retaining credentials and trace headers', async () => {
  const paths = ['/api/v1/mobile/config', '/api/v1/mobile/session', '/api/v1/access/mobile'];
  const seen: Request[] = [];
  const webEnv = { APP_ENV: 'dev', IDENTITY: { fetch: async (request: Request) => { seen.push(request); return Response.json({ traceId: headers['X-Trace-Id'] }); } } } as unknown as WebEnv;
  for (const path of paths) {
    const response = await worker.fetch(new Request(origin + path, { headers }), webEnv);
    assert.equal(response.status, 200);
    assert.equal(seen.at(-1)?.headers.get('authorization'), headers.Authorization);
  }
  const denied = await worker.fetch(new Request(origin + '/api/v99/mobile/session', { headers }), webEnv);
  assert.equal(denied.status, 404);
  assert.equal(seen.length, paths.length);
});
