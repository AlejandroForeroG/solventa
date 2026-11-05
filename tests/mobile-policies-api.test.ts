import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import { createPoliciesApi } from '../apps/mobile/src/features/policy-wallet/adapters/policies-api';
import { PolicyApiFailure } from '../apps/mobile/src/features/policy-wallet/domain/wallet';
import { formatDate, formatDateTime, formatMoney } from '../apps/mobile/src/features/policy-wallet/presentation/format';
import { walletMessages } from '../apps/mobile/src/features/policy-wallet/presentation/messages';

const baseUrl = 'https://solventa-web-dev.ja-forerog1.workers.dev';
const traceId = '00000000-0000-4000-8000-000000000009';
const summary = (extra: Record<string, unknown> = {}) => ({
  policyId: '20000000-0000-4000-8000-000000000001', product: 'vida_hipotecario', status: 'issued', premium: '86400.0000', currency: 'COP',
  effectiveFrom: '2026-10-16T02:00:00.000Z', effectiveUntil: '2027-10-16T02:00:00.000Z', coverage: { kind: 'mortgage_life', sumInsured: '320000000.0000' }, ...extra,
});
const session = { execute: <T>(operation: (token: string) => Promise<T>) => operation('synthetic.jwt.token') };
const json = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const api = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => createPoliciesApi(baseUrl, session, (async (url: string, init: RequestInit) => respond(url, init)) as typeof fetch);

test('the list is requested with the bearer token only, without cookies, and the response keeps just the minimum fields', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const result = await api((url, init) => { seen = { url, init }; return json({ policies: [summary({ document: 'secret', documentHash: 'x'.repeat(64) })], hasMore: true, traceId }); }).list();
  assert.equal(seen?.url, `${baseUrl}/api/v1/policies`);
  assert.equal(seen?.init.method, 'GET');
  assert.equal(seen?.init.credentials, 'omit');
  assert.deepEqual(seen?.init.headers, { Accept: 'application/json', Authorization: 'Bearer synthetic.jwt.token' });
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.policies, [{ policyId: summary().policyId, product: 'vida_hipotecario', premium: '86400.0000', currency: 'COP',
    effectiveFrom: summary().effectiveFrom, effectiveUntil: summary().effectiveUntil, coverage: summary().coverage }]);
});

test('an unauthorized or forbidden session is an authentication failure, not an outage', async () => {
  for (const [status, kind] of [[401, 'unauthorized'], [403, 'forbidden']] as const) {
    await assert.rejects(api(() => json({ error: kind, traceId }, status)).list(), error => error instanceof AuthFailure && error.kind === kind);
  }
});

test('server errors and network failures are outages that let the wallet show its stored copy', async () => {
  for (const respond of [() => json({ error: 'financial_unavailable', traceId }, 503), () => json({}, 500), () => json({ error: 'not_found' }, 404), () => { throw new TypeError('Network request failed'); }]) {
    await assert.rejects(api(respond).list(), error => error instanceof PolicyApiFailure && error.kind === 'unavailable');
  }
});

test('a malformed answer is a contract violation and never reaches the wallet as data', async () => {
  const bodies: unknown[] = [
    'not json', [], { policies: 'x', hasMore: false, traceId }, { policies: [], traceId }, { policies: [], hasMore: false },
    { policies: [], hasMore: false, traceId: 'not-a-uuid' }, { policies: Array.from({ length: 7 }, () => summary()), hasMore: false, traceId },
    { policies: [summary({ premium: 'free' })], hasMore: false, traceId }, { policies: [summary({ product: 'auto' })], hasMore: false, traceId },
  ];
  for (const body of bodies) {
    await assert.rejects(api(() => json(body)).list(), error => error instanceof PolicyApiFailure && error.kind === 'invalid_response', JSON.stringify(body).slice(0, 60));
  }
  await assert.rejects(api(() => json({ policies: [], hasMore: false, traceId }, 200, 'text/html')).list(), error => error instanceof PolicyApiFailure && error.kind === 'invalid_response');
  await assert.rejects(api(() => json('x'.repeat(70 * 1024))).list(), error => error instanceof PolicyApiFailure && error.kind === 'invalid_response');
});

test('only a pinned Solventa gateway is accepted as the API origin', () => {
  assert.throws(() => createPoliciesApi('https://attacker.example', session));
});

test('money is shown as whole pesos and dates in UTC so the stored copy reads the same everywhere', () => {
  assert.match(formatMoney('86400.0000', 'es-CO'), /86[.,\s]?400/);
  assert.match(formatMoney('320000000.0000', 'en-US'), /320,000,000/);
  assert.match(formatDate('2027-10-16T02:00:00.000Z', 'en-US'), /Oct 16, 2027/);
  assert.match(formatDateTime(Date.parse('2026-10-16T02:00:00.000Z'), 'en-US'), /2026/);
});

test('both catalogs define every wallet message', () => {
  const keys = (value: unknown, prefix = ''): string[] => value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => keys(item, `${prefix}${key}.`)) : [prefix];
  assert.deepEqual(keys(walletMessages['en-US']), keys(walletMessages['es-CO']));
});
