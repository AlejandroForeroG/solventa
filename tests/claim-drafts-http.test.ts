import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Hono } from 'hono';
import { ClaimDrafts } from '../backend/policy-claims-payments/src/application/claim-drafts';
import type { ClaimDraftStore } from '../backend/policy-claims-payments/src/application/ports/claim-drafts';
import type { DraftResult } from '../backend/policy-claims-payments/src/domain/claim-draft';
import { mountClaimDrafts } from '../backend/policy-claims-payments/src/adapters/inbound/claim-drafts-http';
import { createDraftApi } from '../apps/mobile/src/features/claim-drafts/adapters/draft-api';
import worker from '../apps/web/worker/index';

const draftId = '30000000-0000-4000-8000-000000000010', policyId = '30000000-0000-4000-8000-000000000011';
const content = { policyId, eventType: 'other' as const, occurredAt: null, place: '', description: 'Synthetic incident notes', evidence: [] };
const version = { draftId, revision: 1, content, updatedAt: '2026-11-12T15:00:00.000Z' };
const command = { commandId: '30000000-0000-4000-8000-000000000012', baseRevision: 0, content };
const principal = { clientId: '30000000-0000-4000-8000-000000000001', subjectToken: '30000000-0000-4000-8000-000000000002' };
const schema = parse(readFileSync('packages/contracts/openapi/v1/claim-drafts.yaml', 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv); ajv.addSchema({ $id: 'draft-contract', ...schema });
const validates = (name: string, value: unknown) => {
  const validate = ajv.compile({ $ref: `draft-contract#/components/schemas/${name}` });
  assert.ok(validate(value), JSON.stringify(validate.errors));
};

function world() {
  const observed: unknown[] = [];
  const state = { allowed: true, actor: 'mobile', fail: false, calls: 0, result: { status: 'confirmed', draft: version, merged: false } as DraftResult };
  const store: ClaimDraftStore = {
    list: async () => [version], get: async () => version, evidence: async () => [],
    sync: async input => { state.calls++; observed.push(input); if (state.fail) throw Error('synthetic database failure'); return state.result; },
  };
  const app = new Hono<{ Bindings: PolicyEnv }>();
  mountClaimDrafts(app, { drafts: new ClaimDrafts(store, { sha256Hex: async text => createHash('sha256').update(text).digest('hex') }),
    authorize: async input => input.token === 'synthetic.jwt.token'
      ? state.allowed ? { allowed: true, actor: { kind: 'user', channel: state.actor, principal, operations: ['claims:report'] } }
        : { allowed: false, status: 403, error: 'forbidden' }
      : { allowed: false, status: 401, error: 'unauthorized' } });
  const fetch = (request: Request) => Promise.resolve(app.fetch(request, {} as PolicyEnv));
  return { fetch, state, observed };
}
const req = (body: unknown = command, headers: Record<string, string> = {}) => new Request(`https://policy.test/api/v1/claim-drafts/${draftId}`, {
  method: 'PUT', headers: { authorization: 'Bearer synthetic.jwt.token', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('the real HTTP use case validates and forwards one canonical owned command, with no-store and contract output', async () => {
  const w = world(); const response = await w.fetch(req());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  validates('Confirmed', await response.json());
  assert.equal(w.state.calls, 1);
  const observed = w.observed[0] as Parameters<ClaimDraftStore['sync']>[0];
  assert.deepEqual(observed.owner, principal); assert.deepEqual(observed.command, command); assert.match(observed.requestHash, /^[a-f0-9]{64}$/);
});

test('absent, revoked, foreign-channel and malformed authorization never reach persistence', async () => {
  const w = world();
  assert.equal((await w.fetch(req(command, { authorization: '' }))).status, 401);
  w.state.allowed = false; assert.equal((await w.fetch(req())).status, 403);
  w.state.allowed = true; w.state.actor = 'web'; assert.equal((await w.fetch(req())).status, 503);
  assert.equal(w.state.calls, 0);
});

test('unknown business fields, malformed JSON and oversized streamed bodies are refused without writes', async () => {
  const w = world();
  for (const body of [{ ...command, premium: 0 }, { ...command, content: { ...content, ownerId: randomUUID() } }, { ...command, baseRevision: -1 }]) {
    const response = await w.fetch(req(body)); assert.equal(response.status, 400); validates('Error', await response.json());
  }
  assert.equal((await w.fetch(new Request(`https://policy.test/api/v1/claim-drafts/${draftId}`, { method: 'PUT', headers: {
    authorization: 'Bearer synthetic.jwt.token', 'content-type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await w.fetch(req({ ...command, content: { ...content, description: 's'.repeat(17_000) } }))).status, 400);
  assert.equal(w.state.calls, 0);
});

test('conflicts return both versions, and a failed transaction cannot acknowledge success', async () => {
  const w = world();
  w.state.result = { status: 'conflict', conflict: { conflictId: command.commandId, draftId, base: version,
    server: { ...version, revision: 2, content: { ...content, description: 'Server edit' } }, local: { ...content, description: 'Local edit' }, fields: ['description'], policy: 'claim-draft.fields.v1' } };
  let response = await w.fetch(req()); assert.equal(response.status, 409); validates('ConflictReply', await response.json());
  w.state.fail = true; response = await w.fetch(req()); assert.equal(response.status, 503); validates('Error', await response.json());
});

test('contractual refusals and methods retain their precise status without a success body', async () => {
  const w = world();
  const failures = { not_found: 404, policy_unavailable: 404, outside_coverage: 422, evidence_unavailable: 422, invalid_base: 409, idempotency_conflict: 409, limit_reached: 409 } as const;
  for (const [status, code] of Object.entries(failures)) {
    w.state.result = { status } as DraftResult;
    const response = await w.fetch(req()); assert.equal(response.status, code); validates('Error', await response.json());
  }
  const response = await w.fetch(new Request(`https://policy.test/api/v1/claim-drafts/${draftId}`, { method: 'DELETE' }));
  assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, PUT');
});

test('the real native adapter consumes list, get, evidence and sync through the public gateway', async () => {
  const w = world(); let forwarded = 0;
  const owners: unknown[] = [];
  const env = { APP_ENV: 'dev', POLICY: { fetch: (r: Request) => { forwarded++; return w.fetch(r); } } } as unknown as WebEnv;
  const transport: typeof fetch = async (input, init) => worker.fetch(new Request(input, init), env);
  const api = createDraftApi('https://dev.solventa.site', { execute: (operation, owner) => { owners.push(owner); return operation('synthetic.jwt.token'); } }, transport);
  assert.deepEqual(await api.list(principal), [version]); assert.deepEqual(await api.get(draftId), version);
  assert.deepEqual(await api.evidence(policyId), []); assert.deepEqual(await api.sync(draftId, command, principal), w.state.result);
  assert.equal(forwarded, 4);
  assert.deepEqual(owners, [principal, undefined, undefined, principal], 'queue reads and writes bind the expected owner at credential execution');
  const unknown = await worker.fetch(new Request('https://dev.solventa.site/api/v1/claim-drafts-other'), env);
  assert.equal(unknown.status, 404); assert.equal(forwarded, 4);
});

test('the native adapter rejects a response for another draft or policy', async () => {
  const w = world(); w.state.result = { status: 'confirmed', draft: { ...version, draftId: randomUUID() }, merged: false };
  const api = createDraftApi('https://dev.solventa.site', { execute: operation => operation('synthetic.jwt.token') }, async (input, init) => w.fetch(new Request(input, init)));
  await assert.rejects(api.sync(draftId, command, principal), { kind: 'invalid_response' });
  w.state.result = { status: 'confirmed', draft: version, merged: false };
  await assert.rejects(api.sync(draftId, { ...command, baseRevision: 2 }, principal), { kind: 'invalid_response' });
  w.state.result = { status: 'conflict', conflict: { conflictId: command.commandId, draftId, base: version,
    server: { ...version, revision: 3 }, local: content, fields: ['description'], policy: 'claim-draft.fields.v1' } };
  await assert.rejects(api.sync(draftId, { ...command, baseRevision: 2 }, principal), { kind: 'invalid_response' });
});

test('only a validated permanent refusal allows correction; an ambiguous error reply stays uncertain', async () => {
  const commandApi = (body: unknown) => createDraftApi('https://dev.solventa.site', { execute: operation => operation('synthetic.jwt.token') }, async () =>
    new Response(JSON.stringify(body), { status: 422, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(commandApi({ error: 'outside_coverage', traceId: randomUUID() }).sync(draftId, command, principal), { kind: 'rejected' });
  await assert.rejects(commandApi({ error: 'unexpected', traceId: randomUUID() }).sync(draftId, command, principal), { kind: 'invalid_response' });
  await assert.rejects(commandApi({ status: 'confirmed' }).sync(draftId, command, principal), { kind: 'invalid_response' });
});
