import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityApiAccess, type IdentityAccessRpc } from '../backend/acquisition-risk/src/adapters/outbound/identity-api-access';
import { PARTNER, WEB } from './support/quote-fakes';

const PARTNER_ID = '10000000-0000-4000-8000-000000000001';
const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const SUBJECT = '40000000-0000-4000-8000-000000000001';
const TRACE = '50000000-0000-4000-8000-000000000001';

const userActor = { kind: 'user', channel: 'web', principal: { clientId: CLIENT_ID, subjectToken: SUBJECT }, operations: ['quotes:create'] };
const partnerActor = { kind: 'partner', partnerId: PARTNER_ID, credentialId: '20000000-0000-4000-8000-000000000001', scopes: ['quotes:create'] };

function rpc(reply: unknown | (() => Promise<unknown>)) {
  const requests: unknown[] = [];
  const identity: IdentityAccessRpc = {
    authorizeApiAccessV1: async request => {
      requests.push(request);
      return typeof reply === 'function' ? (reply as () => Promise<unknown>)() : reply;
    }
  };
  return { requests, access: new IdentityApiAccess(identity, 50) };
}

test('a partner is sent with its token and the fixed operation, and a granted partner becomes a partner actor', async () => {
  const { requests, access } = rpc({ allowed: true, actor: partnerActor });
  assert.deepEqual(await access.authorize(PARTNER), { allowed: true, actor: { kind: 'partner', partnerId: PARTNER_ID } });
  assert.deepEqual(requests, [{ kind: 'partner', token: 'partner-token', operation: 'quotes:create' }]);
});

test('a web user is sent with the sealed cookie value, the Origin and the real method', async () => {
  const { requests, access } = rpc({ allowed: true, actor: userActor });
  assert.deepEqual(await access.authorize(WEB), { allowed: true, actor: { kind: 'user', clientId: CLIENT_ID, subjectToken: SUBJECT } });
  assert.deepEqual(requests, [{ kind: 'web', cookie: 'sealed-cookie', origin: 'https://web.example', method: 'POST', operation: 'quotes:create' }]);
});

test('the actor never carries more than the identifiers the quote needs', async () => {
  const { access } = rpc({ allowed: true, actor: { ...userActor, extra: 'ignored', principal: { clientId: CLIENT_ID, subjectToken: SUBJECT, email: 'x@y.z' } } });
  const decision = await access.authorize(WEB);
  assert.deepEqual(decision, { allowed: true, actor: { kind: 'user', clientId: CLIENT_ID, subjectToken: SUBJECT } });
});

test('authorization preserves a valid correlation UUID and excludes arbitrary trace data', async () => {
  for (const credential of [PARTNER, WEB]) {
    const { requests, access } = rpc({ allowed: false, status: 403 });
    await access.authorize(credential, TRACE.toUpperCase());
    assert.equal((requests[0] as { traceId: string }).traceId, TRACE);
    await access.authorize(credential, 'SyntheticPerson123');
    assert.ok(!JSON.stringify(requests[1]).includes('SyntheticPerson123'));
    assert.ok(!Object.hasOwn(requests[1] as object, 'traceId'));
    for (const invalid of ['50000000-0000-0000-8000-000000000001', '50000000-0000-9000-8000-000000000001', '50000000-0000-4000-7000-000000000001']) {
      await access.authorize(credential, invalid);
      assert.ok(!Object.hasOwn(requests.at(-1) as object, 'traceId'));
    }
  }
});

test('denials keep their status while an unexpected invalid RPC request is an unavailable integration', async () => {
  const expected: [number, number, string][] = [[401, 401, 'unauthorized'], [403, 403, 'forbidden'], [503, 503, 'access_unavailable'], [400, 503, 'access_unavailable']];
  for (const [identityStatus, status, error] of expected) {
    const { access } = rpc({ allowed: false, error: 'whatever', status: identityStatus });
    assert.deepEqual(await access.authorize(PARTNER), { allowed: false, error, status }, String(identityStatus));
  }
});

test('oversized credentials and origin are not forwarded and remain explicit channel authorization attempts', async () => {
  const { requests, access } = rpc({ allowed: false, status: 401 });
  await access.authorize({ kind: 'partner', token: 'a'.repeat(8193) }, TRACE);
  assert.deepEqual(requests[0], { kind: 'partner', token: '', operation: 'quotes:create', traceId: TRACE });
  await access.authorize({ ...WEB, cookie: 'a'.repeat(16385), origin: 'a'.repeat(257) }, TRACE);
  assert.deepEqual(requests[1], { kind: 'web', cookie: '', origin: '', method: 'POST', operation: 'quotes:create', traceId: TRACE });
});

test('anything Acquisition cannot verify blocks the quote as unavailable', async () => {
  const unavailable = { allowed: false, error: 'access_unavailable', status: 503 };
  const replies: unknown[] = [
    undefined, null, 'allowed', 42, {}, { allowed: 'true' }, { allowed: true }, { allowed: true, actor: null },
    { allowed: true, actor: { kind: 'partner', partnerId: 'not-a-uuid' } },
    { allowed: true, actor: { kind: 'partner' } },
    { allowed: true, actor: { kind: 'user', principal: { clientId: CLIENT_ID } } },
    { allowed: true, actor: { kind: 'user', principal: { clientId: 'x', subjectToken: SUBJECT } } },
    { allowed: true, actor: { kind: 'admin', partnerId: PARTNER_ID } },
    { allowed: false, status: 500 }, { allowed: false }
  ];
  for (const reply of replies) assert.deepEqual(await rpc(reply).access.authorize(PARTNER), unavailable, JSON.stringify(reply));
});

test('a failing or hanging Identity call blocks the quote within the deadline', async () => {
  const unavailable = { allowed: false, error: 'access_unavailable', status: 503 };
  assert.deepEqual(await rpc(async () => { throw new Error('binding down at 10.0.0.7'); }).access.authorize(WEB), unavailable);
  const started = Date.now();
  assert.deepEqual(await rpc(() => new Promise(() => {})).access.authorize(WEB), unavailable);
  assert.ok(Date.now() - started < 1000, 'the 50 ms deadline applies');
});

test('the error returned for a failure carries no cause from Identity or the binding', async () => {
  const decision = await rpc(async () => { throw new Error('token abc leaked'); }).access.authorize(PARTNER);
  assert.ok(!JSON.stringify(decision).includes('abc'));
});
