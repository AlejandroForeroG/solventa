import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { IdentityVerification } from '../apps/mobile/src/features/identity-verification/application/identity-verification';
import { createVerificationApi } from '../apps/mobile/src/features/identity-verification/adapters/verification-api';
import { VerificationApiFailure } from '../apps/mobile/src/features/identity-verification/domain/verification';
import { AuthFailure } from '../apps/mobile/src/features/authentication/domain/session';
import type { VerificationApi, VerificationCommand } from '../apps/mobile/src/features/identity-verification/application/ports';
import { verificationHttpSetup } from './support/identity-verification-http';

const baseUrl = 'https://dev.solventa.site';
function fixture() {
  const server = verificationHttpSetup();
  const requests: { key: string | null; body: string; path: string }[] = [];
  const transport = { loseNext: false, corrupt: false, unavailable: false };
  const request: typeof fetch = async (url, options) => {
    assert.equal(options?.credentials, 'omit');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer synthetic.jwt.token');
    assert.equal(new Headers(options?.headers).has('cookie'), false);
    if (transport.unavailable) throw new Error('synthetic network failure');
    const input = new Request(url, options);
    if (input.method !== 'GET') requests.push({ key: input.headers.get('idempotency-key'), body: await input.clone().text(), path: new URL(input.url).pathname });
    const result = await server.app.request(input);
    if (transport.loseNext) { transport.loseNext = false; throw new Error('synthetic lost response after commit'); }
    if (transport.corrupt) {
      const data = await result.json();
      return Response.json({ ...data, verification: { ...data.verification, status: 'approved', result: { simulated: false } } });
    }
    return result;
  };
  const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic.jwt.token') }, request);
  const flow = new IdentityVerification(api, 'es-CO', randomUUID);
  return { ...server, api, flow, requests, transport };
}
async function ready(f: ReturnType<typeof fixture>, document = 'document-readable') {
  await f.flow.load(); await f.flow.grant(true);
  for (const reference of [document, 'selfie-matched', 'liveness-passed']) {
    const input = f.flow.getSnapshot().fixtures.find(item => item.reference === reference)!;
    await f.flow.save(input.step, input);
  }
}

test('actual mobile adapter completes explicit consent, three steps and simulated approval through the Identity HTTP app', async () => {
  const f = fixture(); await f.flow.load();
  await f.flow.grant(false); assert.equal(f.requests.length, 0);
  await ready(f); await f.flow.evaluate();
  assert.equal(f.flow.getSnapshot().verification?.status, 'approved');
  assert.equal(f.flow.getSnapshot().verification?.result?.simulated, true);
  assert.equal(f.flow.getSnapshot().verification?.retryAllowed, false);
  assert.equal(f.requests.length, 5);
  assert.equal(new Set(f.requests.map(item => item.key)).size, 5);
  await f.flow.revoke();
  assert.equal(f.flow.getSnapshot().verification?.status, 'revoked');
  await f.flow.grant(true); assert.equal(f.flow.getSnapshot().verification?.steps.length, 0);
});

test('a lost mutation response retries identical bytes and key without duplicating consent', async () => {
  const f = fixture(); await f.flow.load(); f.transport.loseNext = true;
  await f.flow.grant(true);
  assert.equal(f.flow.getSnapshot().retryPending, true);
  await f.flow.grant(true); assert.equal(f.requests.length, 1);
  await f.flow.retry();
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.equal(f.store.rows.size, 1);
  assert.equal(f.flow.getSnapshot().retryPending, false);
  assert.equal(f.store.events.filter(item => item.action === 'consent_granted').length, 1);
});

test('a failed simulated step retains the other steps and assistance remains one persisted pending reference', async () => {
  const f = fixture(); await ready(f, 'document-unreadable'); await f.flow.evaluate();
  assert.equal(f.flow.getSnapshot().verification?.status, 'not_verified');
  assert.deepEqual(f.flow.getSnapshot().verification?.steps.map(item => item.step), ['selfie', 'liveness']);
  await f.flow.assist(); const assistance = f.flow.getSnapshot().verification?.assistance;
  assert.equal(assistance?.status, 'pending');
  const input = f.flow.getSnapshot().fixtures.find(item => item.reference === 'document-readable')!;
  await f.flow.save(input.step, input); await f.flow.evaluate();
  assert.equal(f.flow.getSnapshot().verification?.status, 'approved');
  assert.deepEqual(f.flow.getSnapshot().verification?.assistance, assistance);
});

test('assistance remains available after editing a failed step and uncertain evaluation can be revoked', async () => {
  const f = fixture(); await ready(f, 'document-unreadable'); await f.flow.evaluate();
  const input = f.flow.getSnapshot().fixtures.find(item => item.reference === 'document-readable')!;
  await f.flow.save(input.step, input);
  assert.equal(f.flow.getSnapshot().verification?.assistanceAllowed, true);
  f.transport.loseNext = true; await f.flow.evaluate();
  assert.equal(f.flow.getSnapshot().retryPending, true);
  await f.flow.revoke();
  assert.equal(f.flow.getSnapshot().verification?.status, 'revoked');
  assert.equal(f.flow.getSnapshot().retryPending, false);
});

test('provider technical failure is confirmed with preserved progress, and a new manual retry uses a new key', async () => {
  const f = fixture(); await ready(f, 'document-technical'); await f.flow.evaluate();
  assert.equal(f.flow.getSnapshot().verification?.status, 'unavailable');
  assert.equal(f.flow.getSnapshot().verification?.steps.length, 3);
  assert.equal(f.flow.getSnapshot().retryPending, false);
  const key = f.requests.at(-1)?.key;
  await f.flow.evaluate(); assert.notEqual(f.requests.at(-1)?.key, key);
  assert.equal(f.flow.getSnapshot().verification?.status, 'unavailable');
  await f.flow.assist(); assert.equal(f.flow.getSnapshot().verification?.assistance?.status, 'pending');
});

test('expiry reconciles authoritative state and requires fresh consent with empty progress', async () => {
  const f = fixture(); await ready(f);
  const current = f.flow.getSnapshot().verification!;
  f.store.now = new Date(Date.parse(current.expiresAt) + 1).toISOString();
  await f.flow.evaluate();
  assert.equal(f.flow.getSnapshot().verification?.status, 'expired');
  assert.equal(f.flow.getSnapshot().retryPending, false);
  await f.flow.grant(true);
  assert.notEqual(f.flow.getSnapshot().verification?.id, current.id);
  assert.equal(f.flow.getSnapshot().verification?.steps.length, 0);
});

test('a stale step version reloads committed progress before allowing another action', async () => {
  const f = fixture(); await ready(f);
  const current = f.flow.getSnapshot().verification!;
  await f.application.saveStep(f.context(current.id), 'document', f.fixture('document-unreadable'), current.version);
  const selfie = f.flow.getSnapshot().fixtures.find(item => item.reference === 'selfie-matched')!;
  await f.flow.save('selfie', selfie);
  assert.equal(f.flow.getSnapshot().error, 'conflict');
  assert.equal(f.flow.getSnapshot().retryPending, false);
  assert.equal(f.flow.getSnapshot().verification?.version, current.version + 1);
  assert.equal(f.flow.getSnapshot().verification?.steps.find(item => item.step === 'document')?.reference, 'document-unreadable');
});

test('unmount and account lock discard late progress rather than publishing another owner state', async () => {
  const f = fixture(); await ready(f);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const original = f.api.current;
  f.api.current = async () => { await waiting; return original(); };
  const loading = f.flow.load(); f.flow.lock(); release(); await loading;
  assert.deepEqual(f.flow.getSnapshot(), { loaded: false, busy: false, verification: null, terms: null, fixtures: [], retryPending: false });
});

test('process restart resumes the server evaluation intent with its original key and original expected version', async () => {
  const f = fixture(); await ready(f);
  const current = f.flow.getSnapshot().verification!;
  const pending = { reference: randomUUID(), idempotencyKey: 'original-evaluation', expectedVersion: current.version };
  const calls: { command: VerificationCommand; key: string }[] = [];
  const api: VerificationApi = { ...f.api,
    current: async () => ({ ...current, version: current.version + 1, status: 'processing', retryAllowed: false, pendingEvaluation: pending }),
    execute: async (command, key) => { calls.push({ command, key }); return current; },
  };
  const restarted = new IdentityVerification(api, 'es-CO', randomUUID); await restarted.load();
  assert.equal(restarted.getSnapshot().retryPending, true); await restarted.retry();
  assert.deepEqual(calls, [{ command: { action: 'evaluate', id: current.id, body: { expectedVersion: current.version } }, key: pending.idempotencyKey }]);
});

test('client rejects forged approval or foreign corpus data instead of rendering success', async () => {
  const f = fixture(); await ready(f); f.transport.corrupt = true;
  await assert.rejects(f.api.current(), VerificationApiFailure);
  assert.equal(f.flow.getSnapshot().verification?.status, 'draft');
  const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic') }, async () => Response.json({ fixtures: [], traceId: randomUUID() }));
  await assert.rejects(api.fixtures(), VerificationApiFailure);
});

test('unauthorized HTTP responses enter the existing session denial path and never become a KYC rejection', async () => {
  const api = createVerificationApi(baseUrl, { execute: operation => operation('synthetic') }, async () => Response.json({ error: 'unauthorized', traceId: randomUUID() }, { status: 401 }));
  await assert.rejects(api.current(), error => error instanceof AuthFailure && error.kind === 'unauthorized');
});
