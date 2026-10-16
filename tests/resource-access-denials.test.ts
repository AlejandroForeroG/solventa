import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyResourceAccess } from '../backend/identity-consent-ecosystem/src/application/resource-access-denials';
import { SecurityDecisions } from '../backend/identity-consent-ecosystem/src/application/security-decisions';
import { canonicalSecurityAlert } from '../backend/identity-consent-ecosystem/src/application/security-alerts';
import type { SecurityDecision } from '../backend/identity-consent-ecosystem/src/domain/security-decision';

const traceId = '50000000-0000-4000-8000-000000000001';
const eventId = '60000000-0000-4000-8000-000000000001';

test('every financial operation produces an allowlisted minimal durable denial and valid alert projection', async () => {
  const decisions: SecurityDecision[] = [];
  const security = new SecurityDecisions({ append: async decision => { decisions.push(decision); } }, () => eventId);
  for (const operation of ['offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue']) {
    assert.deepEqual(await denyResourceAccess(security, { operation, traceId }), { recorded: true });
    const decision = decisions.at(-1)!;
    assert.deepEqual(decision, { schemaVersion: 1, decisionId: eventId, correlationId: traceId, category: 'api_access', channel: 'web', operation, cause: 'forbidden' });
    const projected = canonicalSecurityAlert({ eventId, eventType: 'identity.security_denied', eventVersion: 1, aggregateType: 'security_decision', aggregateId: eventId, correlationId: traceId,
      payload: decision, attempts: 1, createdAt: Date.parse('2026-10-15T00:00:00.000Z'), leaseUntil: Date.parse('2026-10-15T00:01:00.000Z') });
    assert.ok(projected);
    assert.equal(projected.operation, operation);
    assert.deepEqual(Object.keys(projected).sort(), ['category', 'cause', 'channel', 'correlationId', 'decisionId', 'eventId', 'occurredAt', 'operation', 'schemaVersion']);
  }
});

test('the denial RPC rejects extra actor/resource/credential data and operations outside its fixed contract', async () => {
  let writes = 0;
  const security = { deny: async () => { writes++; } };
  for (const input of [{ operation: 'policies:read', traceId, actorId: 'synthetic' }, { operation: 'policies:read', traceId, resourceId: eventId }, { operation: 'policies:read', traceId, cookie: 'synthetic' }, { operation: 'quotes:create', traceId }, { operation: 'policies:read', traceId: 'invalid' }, null, []]) {
    assert.deepEqual(await denyResourceAccess(security, input), { recorded: false, error: 'invalid_request' });
  }
  assert.equal(writes, 0);
});

test('failed durable append never reports a recorded resource denial', async () => {
  assert.deepEqual(await denyResourceAccess({ deny: async () => { throw Error('synthetic SQL failure'); } }, { operation: 'policies:read', traceId }), { recorded: false, error: 'access_unavailable' });
});
