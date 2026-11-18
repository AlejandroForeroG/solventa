import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionState, parseClaimDecision } from '../backend/policy-claims-payments/src/domain/claim-decision';
import { ClaimDecisions } from '../backend/policy-claims-payments/src/application/claim-decisions';
import { Hono } from 'hono';
import { mountClaims } from '../backend/policy-claims-payments/src/adapters/inbound/claims-http';

const actorId = '90000000-0000-4000-8000-000000000001';
const claimId = '90000000-0000-4000-8000-000000000010';
const evidenceId = '90000000-0000-4000-8000-000000000011';
const request = { action: 'approve' as const, reason: 'Verified supporting evidence', evidenceIds: [evidenceId] };

test('decision input rejects missing, duplicate and unexpected evidence or reason fields', () => {
  assert.deepEqual(parseClaimDecision(request), request);
  for (const value of [null, {}, { ...request, reason: 'short' }, { ...request, evidenceIds: [] },
    { ...request, evidenceIds: [evidenceId, evidenceId.toUpperCase()] }, { ...request, evidenceIds: ['bad'] },
    { ...request, actorId }, { ...request, action: 'pay' }]) assert.equal(parseClaimDecision(value), null);
});

test('only the assigned analyst can decide a reviewable claim with verified evidence', () => {
  const context = { state: 'in_review' as const, assigneeId: actorId, actorId, requiredEvidence: 1, verifiedEvidence: 1 };
  assert.equal(decisionState(context, request), 'approved');
  assert.equal(decisionState(context, { ...request, action: 'reject' }), 'rejected');
  assert.equal(decisionState({ ...context, assigneeId: null }, request), 'not_assigned');
  assert.equal(decisionState({ ...context, state: 'approved' }, request), 'invalid_state');
  assert.equal(decisionState({ ...context, verifiedEvidence: 0 }, request), 'incomplete_evidence');
});

test('an expired decision lease never reaches persistence', async () => {
  const decisions = new ClaimDecisions({ decide: async () => { throw new Error('must not write'); } }, { now: () => new Date('2026-11-09T17:00:00Z') });
  await assert.rejects(() => decisions.decide(claimId, request,
    { clientId: actorId, traceId: claimId, expiresAt: '2026-11-09T16:59:59Z' }, 'stable-key'), /claims_authorization_expired/);
});

test('HTTP decision enforces permission and input before invoking the use case', async () => {
  let calls = 0;
  let operation = '';
  const app = new Hono<{ Bindings: PolicyEnv }>();
  mountClaims(app, {
    inbox: { list: async () => ({ items: [], next: null }) },
    decisions: { decide: async () => { calls++; return { status: 'ok', decisionId: claimId, state: 'approved', replayed: false }; } },
    authorize: async input => { operation = input.operation; return { allowed: true, actor: { kind: 'user', channel: 'web',
      operations: ['claims:decide'], principal: { clientId: actorId }, authorizationExpiresAt: new Date(Date.now() + 4000).toISOString() } }; }
  });
  const send = (body: unknown, headers: Record<string, string> = {}) => app.request(`http://localhost:8787/api/v1/claims/${claimId}/decisions`,
    { method: 'POST', body: JSON.stringify(body), headers: { cookie: 'solventa-session=synthetic', origin: 'http://localhost:8787',
      'content-type': 'application/json', 'idempotency-key': 'stable-key', ...headers } }, { APP_ENV: 'local' } as PolicyEnv);
  const invalid = await send({ ...request, evidenceIds: [] });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const success = await send(request);
  assert.equal(success.status, 200);
  assert.equal(operation, 'claims:decide');
  assert.equal(calls, 1);
  const result = await success.json() as { decisionId: string; state: string; replayed: boolean; traceId: string };
  assert.equal(result.decisionId, claimId);
  assert.equal(result.state, 'approved');
  assert.equal(result.replayed, false);
  assert.match(result.traceId, /^[0-9a-f-]{36}$/);
});
