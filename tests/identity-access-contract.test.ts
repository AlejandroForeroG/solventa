import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createHttp } from '../backend/identity-consent-ecosystem/src/adapters/inbound/http';
import { unexpectedAuthentication } from './support/authentication-fakes';
import type { AccessDecision } from '../backend/identity-consent-ecosystem/src/application/api-access';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const spec = parse(read('../packages/contracts/openapi/v1/identity-access.yaml'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ ...parse(read('../packages/contracts/openapi/v1/common.yaml')), $id: 'https://solventa.test/v1/common.yaml' });
ajv.addSchema({ ...spec, $id: 'https://solventa.test/v1/identity-access.yaml' });
const schema = (name: string) => {
  const check = ajv.getSchema(`https://solventa.test/v1/identity-access.yaml#/components/schemas/${name}`);
  if (!check) throw new Error(`schema ${name}`);
  return check;
};

const origin = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const env = { APP_ENV: 'dev' } as IdentityEnv;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const partnerActor = { kind: 'partner', partnerId: crypto.randomUUID(), credentialId: crypto.randomUUID(), scopes: ['quotes:create'] } as const;
const userActor = { kind: 'user', channel: 'web', principal: { clientId: crypto.randomUUID(), subjectToken: crypto.randomUUID() }, operations: ['quotes:create'] } as const;
const denied = (status: 400 | 401 | 403 | 503, error: string): AccessDecision => ({ allowed: false, status, error } as AccessDecision);

type Probe = { path: 'partner' | 'web'; method?: string; headers?: Record<string, string>; decision?: AccessDecision };
async function probe({ path, method = 'GET', headers = {}, decision = denied(401, 'unauthorized') }: Probe) {
  const app = createHttp({ authentication: unexpectedAuthentication, authorizeApiAccess: async () => decision });
  return app.request(`${origin}/api/v1/access/${path}`, { method, headers }, env);
}

function assertDocumented(path: 'partner' | 'web', response: Response) {
  const documented = Object.keys(spec.paths[`/access/${path}`].get.responses);
  assert.ok(documented.includes(String(response.status)), `status ${response.status} is not documented for /access/${path}`);
  assert.match(response.headers.get('x-trace-id') ?? '', UUID);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

const errorCases: { name: string; call: Probe; status: number; error: string }[] = [
  { name: 'partner without credential', call: { path: 'partner' }, status: 401, error: 'unauthorized' },
  { name: 'partner without the required scope', call: { path: 'partner', headers: { authorization: 'Bearer synthetic.jwt.token' }, decision: denied(403, 'forbidden') }, status: 403, error: 'forbidden' },
  { name: 'partner while verification is unavailable', call: { path: 'partner', headers: { authorization: 'Bearer synthetic.jwt.token' }, decision: denied(503, 'access_unavailable') }, status: 503, error: 'access_unavailable' },
  { name: 'partner with a method other than GET', call: { path: 'partner', method: 'POST' }, status: 405, error: 'method_not_allowed' },
  { name: 'web user without a session', call: { path: 'web' }, status: 401, error: 'unauthorized' },
  { name: 'web user sending an Authorization header', call: { path: 'web', headers: { authorization: 'Bearer synthetic.jwt.token' } }, status: 400, error: 'invalid_request' },
  { name: 'web user while verification is unavailable', call: { path: 'web', decision: denied(503, 'access_unavailable') }, status: 503, error: 'access_unavailable' },
  { name: 'web user with a method other than GET', call: { path: 'web', method: 'DELETE' }, status: 405, error: 'method_not_allowed' },
];

test('partner access success matches the PartnerAccess schema', async () => {
  const response = await probe({ path: 'partner', headers: { authorization: 'Bearer synthetic.jwt.token' }, decision: { allowed: true, actor: partnerActor } });
  assert.equal(response.status, 200);
  assertDocumented('partner', response);
  const check = schema('PartnerAccess');
  assert.ok(check(await response.json()), JSON.stringify(check.errors));
});

test('web access success matches the WebAccess schema', async () => {
  const response = await probe({ path: 'web', decision: { allowed: true, actor: userActor } });
  assert.equal(response.status, 200);
  assertDocumented('web', response);
  const check = schema('WebAccess');
  assert.ok(check(await response.json()), JSON.stringify(check.errors));
});

for (const { name, call, status, error } of errorCases) {
  test(`${name} answers a documented ${status} that matches the AccessError schema`, async () => {
    const response = await probe(call);
    assert.equal(response.status, status);
    assertDocumented(call.path, response);
    const body = await response.json();
    const check = schema('AccessError');
    assert.ok(check(body), JSON.stringify(check.errors));
    assert.equal(body.error, error);
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
  });
}
