import { contractSchema } from './support/openapi-schemas';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { PartnerPortal } from '../backend/acquisition-risk/src/application/partner-portal';
import { mountPartnerPortal, portalQuery } from '../backend/acquisition-risk/src/adapters/inbound/partner-portal-http';
import { isPortalData } from '../apps/web/src/partner-portal/api';
import { portalActor, portalApp, portalExample } from './support/partner-portal-fakes';
import { validatePartnerPortalGrantInput } from '../infra/partner-portal-access.mjs';

const identity = { providerSubject: 'synthetic-user', sessionReference: 'synthetic-session', emailVerified: true };
const sessions = { find: async () => portalActor().principal, open: async () => portalActor().principal, revoke: async () => {} };
const query = 'from=2026-11-01&to=2026-11-07';
test('portal access requires an explicit web grant and never elevates mobile or partner credentials', async () => {
  const denied = { allowed: false, error: 'forbidden', status: 403 };
  const noGrant = new ApiAccess({ find: async () => null }, sessions);
  assert.deepEqual(await noGrant.webUser(identity, 'partner-portal:read'), denied);
  let calls = 0;
  const api = new ApiAccess({ find: async () => null }, sessions, undefined, undefined, { find: async () => { calls++; return portalActor().partnerPortal; } });
  assert.equal((await api.webUser(identity, 'partner-portal:read')).allowed, true);
  assert.deepEqual(await api.mobileUser(identity, 'partner-portal:read'), denied);
  assert.deepEqual(await api.partner({ issuer: 'synthetic', applicationId: 'test', organizationId: 'test', scopes: ['partner-portal:read'] }, 'partner-portal:read'), denied);
  assert.equal(calls, 1);
});
test('portal grants fail closed on expired, excessive or unavailable leases', async () => {
  for (const delta of [-1, 10000]) {
    const api = new ApiAccess({ find: async () => null }, sessions, undefined, undefined, { find: async () => ({ ...portalActor().partnerPortal, expiresAt: new Date(Date.now() + delta).toISOString() }) });
    assert.equal((await api.webUser(identity, 'partner-portal:read')).allowed, false);
  }
  const api = new ApiAccess({ find: async () => null }, sessions, undefined, undefined, { find: async () => { throw Error('SQL down'); } });
  assert.deepEqual(await api.webUser(identity, 'partner-portal:read'), { allowed: false, error: 'access_unavailable', status: 503 });
});
test('period parsing rejects impossible, repeated, inverted, excessive and unknown parameters', () => {
  for (const q of ['',query + '&partnerId=other',query + '&from=2026-11-01','from=2026-02-30&to=2026-03-01','from=2026-11-07&to=2026-11-01','from=2026-01-01&to=2026-02-01']) assert.equal(portalQuery(new URLSearchParams(q)), null, q);
  assert.deepEqual(portalQuery(new URLSearchParams('from=2026-01-01&to=2026-01-31')), { from: '2026-01-01', to: '2026-01-31' });
});
test('HTTP returns safe grant metadata, actual facts and a genuine empty state, but never zero after store failure', async () => {
  for (const mode of ['ready','empty','unavailable','denied'] as const) {
    const response = await portalApp(mode).request('https://dev.solventa.site/api/v1/partner-portal?' + query, undefined, { APP_ENV: 'dev' } as AcquisitionEnv);
    assert.equal(response.status, mode === 'unavailable' ? 503 : mode === 'denied' ? 403 : 200);
    const body = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (response.status === 200) { assert.ok(isPortalData(body)); assert.equal(body.items.length, mode === 'empty' ? 0 : 2); assert.deepEqual(body.quota, { configured: false }); }
    else assert.equal('totals' in body, false);
    assert.equal(JSON.stringify(body).includes('credential_reference'), false);
  }
});
test('HTTP never reads activity for malformed actor, operation, lease or credential enum', async () => {
  let reads = 0;
  for (const change of [{ kind: 'partner' }, { channel: 'mobile' }, { operations: [] }, { authorizationExpiresAt: new Date(0).toISOString() },
    { partnerPortal: { ...portalActor().partnerPortal, credentials: [{ ...portalExample.credentials[0], status: ['active'] }] } }]) {
    const app = new Hono<{ Bindings: AcquisitionEnv }>();
    mountPartnerPortal(app, { authorize: async () => ({ allowed: true, actor: { ...portalActor(), ...change } }), versions: [], portal: { read: async () => { reads++; throw Error('unexpected_read'); } } });
    assert.equal((await app.request('https://dev.solventa.site/api/v1/partner-portal?' + query, undefined, { APP_ENV: 'dev' } as AcquisitionEnv)).status, 503);
  }
  assert.equal(reads, 0);
});
test('lease expiry during the SQL read prevents releasing data', async () => {
  let now = 0;
  const portal = new PartnerPortal({ read: async () => { now = 1000; return { ...portalExample, items: [] }; } }, () => now);
  await assert.rejects(portal.read(portalExample.partner.id, { from: '2026-11-01', to: '2026-11-07' }, new Date(1000).toISOString()), /access_expired/);
});
test('client rejects malformed enums, invalid dates, negative counts and inconsistent period responses', () => {
  assert.ok(isPortalData(portalExample));
  for (const body of [ { ...portalExample, credentials: [{ ...portalExample.credentials[0], status: ['active'] }] },
    { ...portalExample, items: [{ ...portalExample.items[0], result: ['accepted'] }] }, { ...portalExample, updatedAt: '2026-02-30T00:00:00Z' },
    { ...portalExample, totals: { ...portalExample.totals, completed: -1 } }, { ...portalExample, quota: { configured: 'false' } } ]) assert.equal(isPortalData(body), false);
});
test('operator validates exact grant binding and a bounded explicit expiry', () => {
  const input = { grantId: portalExample.traceId, clientId: portalActor().principal.clientId, partnerId: portalExample.partner.id, operatorReference: portalExample.traceId, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  assert.equal(validatePartnerPortalGrantInput('local', 'grant', input).partnerId, input.partnerId);
  for (const invalid of [{ ...input, partnerId: '' }, { ...input, extra: true }, { ...input, expiresAt: new Date(Date.now() + 91 * 86400000).toISOString() }]) assert.throws(() => validatePartnerPortalGrantInput('local', 'grant', invalid));
});

test('the documented response and real HTTP output satisfy the same OpenAPI schema', async () => {
  const schema = contractSchema('partner-portal', 'PartnerPortal');
  assert.equal(schema(portalExample).valid, true);
  const response = await portalApp().request('https://dev.solventa.site/api/v1/partner-portal?'+query, undefined, { APP_ENV: 'dev' } as AcquisitionEnv);
  const checked = schema(await response.json()); assert.equal(checked.valid, true, checked.errors);
  assert.equal(schema({ ...portalExample, quota: { configured: true } }).valid, false);
});
