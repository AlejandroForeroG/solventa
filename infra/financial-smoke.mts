import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import type { FinancialDecisionCapture } from '../backend/policy-claims-payments/src/application/financial-decision';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { PolicyFinance } from '../backend/policy-claims-payments/src/application/policy-finance';
import { SqlFinancialStore } from '../backend/policy-claims-payments/src/adapters/outbound/sql-financial-store';
import { MockSignatureProvider, SqlMockPaymentGateway } from '../backend/policy-claims-payments/src/adapters/outbound/mock-financial-providers';
import { eventContent, issuanceTimeContent } from '../backend/policy-claims-payments/src/domain/financial';
import type { AcceptedOffer, FinancialResult, SignedOfferAcceptanceV1 } from '../backend/policy-claims-payments/src/domain/financial';
import type { FinancialDependencies, FinancialStore, PaymentGateway, SignatureProvider } from '../backend/policy-claims-payments/src/application/ports/financial';
import { acceptedOffer, financialIntegrity, financialNow, flightEvent } from '../tests/financial-fixtures';

// Real disposable SQL and the real Policy runtime grants. Only external provider protocols are mocked.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_financial_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_financial_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let migrationsComplete = false;
let testFailure: unknown;
let db: ReturnType<typeof clientFor> | undefined;
const auditTimingsMs: number[] = [];
try {
  await admin.connect();
  const held = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  assert.equal(held.database, 'solventa_local');
  assert.match(held.passwords.policy, /^[a-f0-9]{64}$/);
  const users = (await admin.query('SHOW USERS')).rows;
  if (!users.some(user => user.username === 'solventa_local_policy')) {
    await admin.query(`CREATE USER solventa_local_policy WITH PASSWORD '${held.passwords.policy}'`);
  }
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA policy');
  await db.query('CREATE TABLE policy.schema_migrations(version STRING PRIMARY KEY,checksum STRING NOT NULL,applied_at TIMESTAMPTZ DEFAULT now())');
  const owner = owners.find(owner => owner.schema === 'policy');
  assert.ok(owner);
  await applyMigrations(db, owner);
  await applyMigrations(db, owner);
  migrationsComplete = true;
  const grants = JSON.parse(await readFile('backend/policy-claims-payments/runtime-grants.json', 'utf8')) as Record<string, string[]>;
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_policy`);
  await db.query('GRANT USAGE ON SCHEMA policy TO solventa_local_policy');
  for (const [table, privileges] of Object.entries(grants)) await db.query(`GRANT ${privileges.join(',')} ON policy.${table} TO solventa_local_policy`);
  const runtime = new URL(url); runtime.username = 'solventa_local_policy'; runtime.password = held.passwords.policy;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const store = new SqlFinancialStore(runtime.toString());
  const gateway = new SqlMockPaymentGateway(runtime.toString());
  const base: FinancialDependencies = { enabled: true, environment: 'local', integrity: financialIntegrity, store,
    payments: gateway, signatures: new MockSignatureProvider(financialIntegrity), now: financialNow, newId: randomUUID };
  const finance = new PolicyFinance(base);
  const count = async (table: string) => Number((await db!.query(`SELECT count(*)::INT4 AS n FROM policy.${table}`)).rows[0].n);
  const captures = async (policyId: string, action: string) => (await db!.query<{ payload: FinancialDecisionCapture }>(
    'SELECT payload FROM policy.outbox_events WHERE aggregate_id=$1 AND event_type=$2 ORDER BY created_at,event_id', [policyId, 'policy.' + action])).rows.map(row => row.payload);
  const counts = async (tables: string[]) => { const result = []; for (const table of tables) result.push(await count(table)); return result; };
  const ok = (result: FinancialResult) => { assert.equal(result.status, 'ok', JSON.stringify(result)); if (result.status !== 'ok') throw new Error('unexpected_result'); return result; };
  const importOffer = async (event: SignedOfferAcceptanceV1) => ok(await finance.acceptOffer(event, randomUUID())).policy;
  const challengeByCommand = new Map<string, { challengeId: string; code: string }>();
  const issue = async (service: PolicyFinance, event: SignedOfferAcceptanceV1, policy: { policyId: string; documentHash: string }, key = randomUUID()) => {
    const actor = { clientId: event.payload.clientId, subjectToken: event.payload.subjectToken };
    const identity = `${policy.policyId}:${key}`;
    let challenge = challengeByCommand.get(identity);
    if (!challenge) {
      const charged = await service.charge({ actor, policyId: policy.policyId, documentHash: policy.documentHash,
        idempotencyKey: `charge-${policy.policyId}`, traceId: randomUUID() });
      if (charged.status !== 'ok') return charged;
      const started = await service.beginSignatureChallenge({ actor, policyId: policy.policyId, documentHash: policy.documentHash,
        accepted: true, traceId: randomUUID() });
      if (started.status === 'ok' && started.challenge) {
        challenge = { challengeId: started.challenge.challengeId, code: started.challenge.demoCode };
        challengeByCommand.set(identity, challenge);
      } else challenge = { challengeId: '80000000-0000-4000-8000-000000000008', code: '000000' };
    }
    return service.issue({ actor, policyId: policy.policyId, documentHash: policy.documentHash, idempotencyKey: key,
      challengeId: challenge.challengeId, code: challenge.code, traceId: randomUUID() });
  };
  const denied = async (run: (traceId: string) => Promise<FinancialResult>, code: string) => {
    const traceId = randomUUID();
    const before = await count('mock_gateway_operations');
    const effectsBefore = (await db!.query('SELECT payment_id,operation,amount::STRING,currency,status,provider_reference FROM policy.mock_gateway_operations ORDER BY payment_id')).rows;
    const started = performance.now();
    const result = await run(traceId);
    assert.ok(result.status === 'denied' && result.error === code, JSON.stringify(result));
    const audits = (await db!.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE correlation_id=$1 AND action='financial.denied' AND outcome=$2", [traceId, code])).rows[0].n;
    assert.equal(audits, 1);
    const outbox = (await db!.query("SELECT count(*)::INT4 AS n FROM policy.outbox_events WHERE correlation_id=$1 AND event_type='policy.financial.denied'", [traceId])).rows[0].n;
    assert.equal(outbox, 1);
    const elapsed = performance.now() - started;
    assert.ok(elapsed <= 5000, 'rejection audit not visible within five seconds');
    auditTimingsMs.push(Math.round(elapsed * 100) / 100);
    assert.equal(await count('mock_gateway_operations'), before, 'a rejection must not call the financial provider');
    assert.deepEqual((await db!.query('SELECT payment_id,operation,amount::STRING,currency,status,provider_reference FROM policy.mock_gateway_operations ORDER BY payment_id')).rows, effectsBefore,
      'a rejection must not change an already existing financial provider outcome');
  };

  const attemptOffer = await acceptedOffer(), attemptPolicy = await importOffer(attemptOffer);
  const attemptInput = { actor: attemptOffer.payload, policyId: attemptPolicy.policyId, documentHash: attemptPolicy.documentHash };
  assert.equal(ok(await finance.charge({ ...attemptInput, idempotencyKey: randomUUID(), traceId: randomUUID() })).policy.status, 'charged');
  const beginAttempt = async () => {
    const challenge = ok(await finance.beginSignatureChallenge({ ...attemptInput, accepted: true, traceId: randomUUID() })).challenge;
    assert.ok(challenge); return challenge;
  };
  const limitedChallenge = await beginAttempt();
  const wrongCode = limitedChallenge.demoCode === '000000' ? '111111' : '000000';
  for (let attempts = 1; attempts <= 3; attempts++) {
    await denied(traceId => finance.issue({ ...attemptInput, idempotencyKey: randomUUID(),
      challengeId: limitedChallenge.challengeId, code: wrongCode, traceId }), 'authentication_failed');
    const saved = (await db.query('SELECT attempts::INT4 AS attempts,status FROM policy.signature_challenges WHERE id=$1', [limitedChallenge.challengeId])).rows[0];
    assert.deepEqual(saved, { attempts, status: attempts === 3 ? 'cancelled' : 'active' });
    const failures = await captures(attemptPolicy.policyId, 'signature.challenge_failed');
    assert.equal(failures.length, attempts);
    assert.equal((failures.at(-1)!.inputs.challenge as { attempts: unknown }).attempts, attempts,
      'failed authentication must persist the numeric attempt count in its decision capture');
  }
  await denied(traceId => finance.issue({ ...attemptInput, idempotencyKey: randomUUID(),
    challengeId: limitedChallenge.challengeId, code: limitedChallenge.demoCode, traceId }), 'challenge_invalid');
  const cancelledChallenge = await beginAttempt();
  ok(await finance.cancelSignatureChallenge({ actor: attemptInput.actor, policyId: attemptPolicy.policyId,
    challengeId: cancelledChallenge.challengeId, traceId: randomUUID() }));
  await denied(traceId => finance.issue({ ...attemptInput, idempotencyKey: randomUUID(),
    challengeId: cancelledChallenge.challengeId, code: cancelledChallenge.demoCode, traceId }), 'challenge_invalid');
  const expiringChallenge = await beginAttempt();
  const atChallengeExpiry = new PolicyFinance({ ...base, now: () => new Date(expiringChallenge.expiresAt) });
  await denied(traceId => atChallengeExpiry.issue({ ...attemptInput, idempotencyKey: randomUUID(),
    challengeId: expiringChallenge.challengeId, code: expiringChallenge.demoCode, traceId }), 'challenge_expired');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.policy_signatures WHERE policy_id=$1', [attemptPolicy.policyId])).rows[0].n, 0);
  assert.equal(ok(await finance.get({ actor: attemptInput.actor, policyId: attemptPolicy.policyId, traceId: randomUUID() })).policy.status, 'charged');
  const validChallenge = await beginAttempt();
  assert.equal(ok(await finance.issue({ ...attemptInput, idempotencyKey: randomUUID(), challengeId: validChallenge.challengeId,
    code: validChallenge.demoCode, traceId: randomUUID() })).policy.status, 'issued');
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.payments WHERE policy_id=$1 AND operation='premium'", [attemptPolicy.policyId])).rows[0].n, 1);

  const offer = await acceptedOffer();
  const policy = await importOffer(offer);
  const originalCounts = await counts(['policies', 'inbox_events', 'audit_events', 'outbox_events']);
  assert.equal(ok(await finance.acceptOffer(offer, randomUUID())).replayed, true);
  assert.deepEqual(await counts(['policies', 'inbox_events', 'audit_events', 'outbox_events']), originalCounts);
  await db.query('UPDATE policy.policies SET premium=1 WHERE id=$1', [policy.policyId]);
  await denied(traceId => finance.acceptOffer(offer, traceId), 'integrity_violation');
  await db.query('UPDATE policy.policies SET premium=$2 WHERE id=$1', [policy.policyId, offer.payload.premium]);
  assert.equal(ok(await finance.acceptOffer(offer, randomUUID())).replayed, true);
  const duplicateOffer = { ...offer, eventId: randomUUID(), payload: { ...offer.payload, acceptanceId: randomUUID() } };
  duplicateOffer.signature = await financialIntegrity.digest(eventContent(duplicateOffer));
  await denied(traceId => finance.acceptOffer(duplicateOffer, traceId), 'event_conflict');
  assert.equal(ok(await finance.getByAcceptance({ actor: offer.payload, acceptanceId: offer.payload.acceptanceId, traceId: randomUUID() })).policy.policyId, policy.policyId);
  const snapshotReads: Promise<FinancialResult>[] = [];
  await db.query('BEGIN');
  try {
    await db.query('SELECT id FROM policy.policies WHERE id=$1 FOR UPDATE', [policy.policyId]);
    await db.query('UPDATE policy.policies SET premium=1 WHERE id=$1', [policy.policyId]);
    snapshotReads.push(finance.get({ actor: offer.payload, policyId: policy.policyId, traceId: randomUUID() }),
      finance.getByAcceptance({ actor: offer.payload, acceptanceId: offer.payload.acceptanceId, traceId: randomUUID() }));
    // Serializable reads may wait on the writer. Release within the normal query deadline;
    // either schedule must expose a committed, coherent snapshot, never the uncommitted tamper.
    await new Promise(resolve => setTimeout(resolve, 250));
  } finally { await db.query('ROLLBACK'); }
  for (const result of await Promise.all(snapshotReads)) {
    const read = ok(result).policy;
    assert.equal(read.policyId, policy.policyId);
    assert.equal(read.premium, policy.premium);
    assert.equal(read.documentHash, policy.documentHash);
  }

  await denied(traceId => finance.get({ actor: { clientId: randomUUID(), subjectToken: randomUUID() }, policyId: policy.policyId, traceId }), 'not_found');
  await denied(traceId => finance.issue({ actor: offer.payload, policyId: policy.policyId, documentHash: '0'.repeat(64), idempotencyKey: randomUUID(), challengeId: '80000000-0000-4000-8000-000000000008', code: '000000', traceId }), 'document_mismatch');
  const altered = { ...offer, payload: { ...offer.payload, premium: '1.0000' } };
  await denied(traceId => finance.acceptOffer(altered, traceId), 'invalid_event');
  altered.signature = await financialIntegrity.digest(eventContent(altered));
  await denied(traceId => finance.acceptOffer(altered, traceId), 'event_conflict');
  const expired = await acceptedOffer(); expired.payload.acceptedAt = expired.payload.expiresAt;
  expired.signature = await financialIntegrity.digest(eventContent(expired));
  await denied(traceId => finance.acceptOffer(expired, traceId), 'invalid_event');

  const importRollback = await acceptedOffer();
  const importTables = ['policies', 'financial_contracts', 'inbox_events', 'audit_events', 'outbox_events'];
  const beforeImportFailure = await counts(importTables);
  for (const table of ['policies', 'financial_contracts', 'inbox_events', 'audit_events', 'outbox_events']) {
    await db.query(`REVOKE INSERT ON policy.${table} FROM solventa_local_policy`);
    try { assert.equal((await finance.acceptOffer(importRollback, randomUUID())).status, 'unavailable'); }
    finally { await db.query(`GRANT INSERT ON policy.${table} TO solventa_local_policy`); }
    assert.deepEqual(await counts(importTables), beforeImportFailure,
      `a failed ${table} insert must roll back policy, contract, inbox, audit and outbox together`);
  }
  assert.equal((await importOffer(importRollback)).status, 'pending');

  const offerEvidence = async (event: SignedOfferAcceptanceV1) => (await db!.query(`SELECT
    (SELECT count(*)::INT4 FROM policy.financial_contracts WHERE terms->>'offerId'=$1) AS contracts,
    (SELECT count(*)::INT4 FROM policy.policies WHERE offer_id=$2) AS policies,
    (SELECT count(*)::INT4 FROM policy.inbox_events i JOIN policy.policies p ON p.id=i.policy_id WHERE p.offer_id=$2) AS inbox,
    (SELECT count(*)::INT4 FROM policy.audit_events a JOIN policy.policies p ON p.id=a.resource_id WHERE p.offer_id=$2 AND a.action='offer.accepted') AS audits,
    (SELECT count(*)::INT4 FROM policy.outbox_events o JOIN policy.policies p ON p.id=o.aggregate_id WHERE p.offer_id=$2 AND o.event_type='policy.offer.accepted') AS outbox`,
  [event.payload.offerId, event.payload.offerId])).rows[0];
  const redelivered = await acceptedOffer();
  const deliveries = (await Promise.all(Array.from({ length: 3 }, () => finance.acceptOffer(redelivered, randomUUID())))).map(ok);
  assert.equal(deliveries.filter(result => !result.replayed).length, 1, 'concurrent redelivery must create exactly one policy');
  assert.equal(new Set(deliveries.map(result => result.policy.policyId)).size, 1);
  assert.deepEqual(await offerEvidence(redelivered), { contracts: 1, policies: 1, inbox: 1, audits: 1, outbox: 1 });
  const contested = await acceptedOffer();
  const rival = { ...contested, eventId: randomUUID(), payload: { ...contested.payload, acceptanceId: randomUUID() } };
  rival.signature = await financialIntegrity.digest(eventContent(rival));
  const rivalTraces = [randomUUID(), randomUUID()];
  const contest = await Promise.all([finance.acceptOffer(contested, rivalTraces[0]), finance.acceptOffer(rival, rivalTraces[1])]);
  assert.equal(contest.filter(result => result.status === 'ok').length, 1, JSON.stringify(contest));
  const loser = contest.findIndex(result => result.status !== 'ok'), lost = contest[loser];
  assert.ok(lost.status === 'denied' && lost.error === 'event_conflict', JSON.stringify(contest));
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE correlation_id=$1 AND action='financial.denied' AND outcome='event_conflict'",
    [rivalTraces[loser]])).rows[0].n, 1, 'the losing envelope must be an audited conflict');
  assert.deepEqual(await offerEvidence(contested), { contracts: 1, policies: 1, inbox: 1, audits: 1, outbox: 1 });

  const orphanOffer = await acceptedOffer(); const orphanPolicy = await importOffer(orphanOffer);
  await db.query(`INSERT INTO policy.payments(id,policy_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
    VALUES($1,$2,'premium','initial-premium',$3,$4,'COP','pending',$5)`,
  [randomUUID(), orphanPolicy.policyId, '0'.repeat(64), orphanOffer.payload.premium, randomUUID()]);
  // Ownership is resolved before the joined evidence is decoded, even if the foreign record is malformed.
  for (const foreignActor of [{ clientId: randomUUID(), subjectToken: randomUUID() },
    { clientId: randomUUID(), subjectToken: orphanOffer.payload.subjectToken },
    { clientId: orphanOffer.payload.clientId, subjectToken: randomUUID() }]) {
    await denied(traceId => finance.get({ actor: foreignActor, policyId: orphanPolicy.policyId, traceId }), 'not_found');
    await denied(traceId => finance.issue({ actor: foreignActor, policyId: orphanPolicy.policyId, documentHash: orphanPolicy.documentHash,
      idempotencyKey: randomUUID(), challengeId: '80000000-0000-4000-8000-000000000008', code: '000000', traceId }), 'not_found');
    await denied(traceId => finance.getByAcceptance({ actor: foreignActor, acceptanceId: orphanOffer.payload.acceptanceId, traceId }), 'not_found');
  }
  const pendingTrace = randomUUID();
  assert.deepEqual(await finance.getByAcceptance({ actor: orphanOffer.payload, acceptanceId: randomUUID(), traceId: pendingTrace }),
    { status: 'denied', error: 'policy_pending', httpStatus: 404, traceId: pendingTrace });
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE correlation_id=$1', [pendingTrace])).rows[0].n, 0,
    'polling an acceptance that is not imported yet must not record a rejection');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.outbox_events WHERE correlation_id=$1', [pendingTrace])).rows[0].n, 0,
    'polling an unimported acceptance must not publish a rejection');
  await denied(traceId => finance.issue({ actor: orphanOffer.payload, policyId: orphanPolicy.policyId, documentHash: orphanPolicy.documentHash,
    idempotencyKey: randomUUID(), challengeId: '80000000-0000-4000-8000-000000000008', code: '000000', traceId }), 'integrity_violation');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.financial_payment_intents WHERE policy_id=$1', [orphanPolicy.policyId])).rows[0].n, 0,
    'an orphan payment must not be hidden by the absent intent or replaced by a new premium');

  const key = randomUUID();
  const intentRollback = await acceptedOffer(); const intentRollbackPolicy = await importOffer(intentRollback); const intentRollbackKey = randomUUID();
  const intentTables = ['payments', 'financial_payment_intents', 'financial_commands', 'audit_events', 'outbox_events', 'mock_gateway_operations'];
  const beforeIntentFailure = await counts(intentTables);
  for (const table of ['financial_commands', 'payments', 'financial_payment_intents', 'audit_events', 'outbox_events']) {
    await db.query(`REVOKE INSERT ON policy.${table} FROM solventa_local_policy`);
    try { assert.equal((await finance.charge({ actor: intentRollback.payload, policyId: intentRollbackPolicy.policyId,
      documentHash: intentRollbackPolicy.documentHash, idempotencyKey: `charge-${intentRollbackPolicy.policyId}`,
      traceId: randomUUID() })).status, 'unavailable'); }
    finally { await db.query(`GRANT INSERT ON policy.${table} TO solventa_local_policy`); }
    assert.deepEqual(await counts(intentTables), beforeIntentFailure,
      `a failed ${table} insert must roll back initial command, premium, immutable intent, audit and outbox before provider use`);
  }
  assert.equal(ok(await issue(finance, intentRollback, intentRollbackPolicy, intentRollbackKey)).policy.status, 'issued');
  const noProofOffer = await acceptedOffer(); const noProofPolicy = await importOffer(noProofOffer); const noProofKey = randomUUID();
  const noProofGateway: PaymentGateway = { lookup: payment => gateway.lookup(payment), refund: payment => gateway.refund(payment),
    async settle() { return { status: 'uncertain', reference: null }; } };
  assert.equal((await issue(new PolicyFinance({ ...base, payments: noProofGateway }), noProofOffer, noProofPolicy, noProofKey)).status, 'unavailable');
  await db.query("UPDATE policy.policies SET status='charged' WHERE id=$1", [noProofPolicy.policyId]);
  await db.query("UPDATE policy.payments SET status='confirmed',provider_reference='MOCK-'||id::STRING WHERE policy_id=$1", [noProofPolicy.policyId]);
  await denied(traceId => finance.charge({ actor: noProofOffer.payload, policyId: noProofPolicy.policyId, documentHash: noProofPolicy.documentHash,
    idempotencyKey: `charge-${noProofPolicy.policyId}`, traceId }), 'integrity_violation');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [noProofPolicy.policyId])).rows[0].n, 0,
    'a forged charged/confirmed projection with no provider proof must never start a new charge');
  const declinedOffer = await acceptedOffer(); const declinedPolicy = await importOffer(declinedOffer); const declinedKey = randomUUID();
  let interruptDecline = true;
  const decliningGateway: PaymentGateway = { async lookup() { return { status: 'unknown', reference: null }; }, refund: payment => gateway.refund(payment),
    async settle() { if (interruptDecline) { interruptDecline = false; await db!.query('REVOKE INSERT ON policy.outbox_events FROM solventa_local_policy'); } return { status: 'declined', reference: null }; } };
  const decliningService = new PolicyFinance({ ...base, payments: decliningGateway });
  try { assert.equal((await issue(decliningService, declinedOffer, declinedPolicy, declinedKey)).status, 'unavailable'); }
  finally { await db.query('GRANT INSERT ON policy.outbox_events TO solventa_local_policy'); }
  assert.equal((await db.query("SELECT status FROM policy.payments WHERE policy_id=$1 AND operation='premium'", [declinedPolicy.policyId])).rows[0].status, 'pending',
    'a declined transition must roll back when its corresponding outbox write fails');
  const declineResult = await issue(decliningService, declinedOffer, declinedPolicy, declinedKey);
  assert.ok(declineResult.status === 'denied' && declineResult.error === 'payment_declined');
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE resource_id=$1 AND action='premium.requested'", [declinedPolicy.policyId])).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE resource_id=$1 AND action='premium.declined'", [declinedPolicy.policyId])).rows[0].n, 1);
  assert.equal(ok(await issue(finance, offer, policy, key)).policy.status, 'issued');
  const legacyEvent = await acceptedOffer(), legacyPolicy = await importOffer(legacyEvent), legacyKey = randomUUID();
  const legacyIssue = () => finance.issueLegacy({ actor: legacyEvent.payload, policyId: legacyPolicy.policyId,
    documentHash: legacyPolicy.documentHash, idempotencyKey: legacyKey, traceId: randomUUID() });
  assert.equal(ok(await legacyIssue()).policy.status, 'issued');
  assert.equal(ok(await legacyIssue()).replayed, true);
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [legacyPolicy.policyId])).rows[0].status, 'issued');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.policy_signatures WHERE policy_id=$1', [legacyPolicy.policyId])).rows[0].n, 1);
  const financialCounts = await counts(['payments', 'policy_signatures', 'mock_gateway_operations']);
  assert.equal(ok(await issue(new PolicyFinance({ ...base, payments: new SqlMockPaymentGateway(runtime.toString()) }), offer, policy, key)).replayed, true);
  assert.deepEqual(await counts(['payments', 'policy_signatures', 'mock_gateway_operations']), financialCounts);
  const existingPremium = (await store.readPolicy(policy.policyId, offer.payload))?.premium;
  assert.ok(existingPremium);
  const originalGateway = (await db.query('SELECT * FROM policy.mock_gateway_operations WHERE payment_id=$1', [existingPremium.id])).rows;
  assert.deepEqual(await gateway.settle(existingPremium), { status: 'confirmed', reference: 'MOCK-' + existingPremium.id });
  for (const changed of [{ ...existingPremium, hash: '0'.repeat(64) }, { ...existingPremium, amount: '1.00' }]) {
    await assert.rejects(gateway.settle(changed), /mock_gateway_conflict/);
  }
  assert.deepEqual((await db.query('SELECT * FROM policy.mock_gateway_operations WHERE payment_id=$1', [existingPremium.id])).rows, originalGateway,
    'a settlement replay or collision cannot overwrite the durable mock operation');
  const sameActorOffer = await acceptedOffer();
  sameActorOffer.payload.clientId = offer.payload.clientId;
  sameActorOffer.payload.subjectToken = offer.payload.subjectToken;
  sameActorOffer.signature = await financialIntegrity.digest(eventContent(sameActorOffer));
  const sameActorPolicy = await importOffer(sameActorOffer);
  await denied(traceId => finance.issue({ actor: offer.payload, policyId: sameActorPolicy.policyId, documentHash: sameActorPolicy.documentHash, idempotencyKey: key, challengeId: '80000000-0000-4000-8000-000000000008', code: '000000', traceId }), 'idempotency_conflict');
  const racing = await acceptedOffer(); const racingPolicy = await importOffer(racing); const racingKey = randomUUID();
  const race = await Promise.all(Array.from({ length: 4 }, () => issue(finance, racing, racingPolicy, racingKey)));
  assert.ok(race.every(result => result.status === 'ok'), JSON.stringify(race));
  assert.equal(Number((await db.query('SELECT count(*)::INT4 AS n FROM policy.payments WHERE policy_id=$1', [racingPolicy.policyId])).rows[0].n), 1);
  assert.equal(Number((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [racingPolicy.policyId])).rows[0].n), 1);

  // The external mock commits before its response is lost. A new service instance recovers by lookup.
  let uncertain = true;
  const uncertainGateway: PaymentGateway = { lookup: payment => gateway.lookup(payment), refund: payment => gateway.refund(payment),
    async settle(payment) { const result = await gateway.settle(payment); if (uncertain) { uncertain = false; return { status: 'uncertain', reference: null }; } return result; } };
  const recoveryOffer = await acceptedOffer(); const recoveryPolicy = await importOffer(recoveryOffer); const recoveryKey = randomUUID();
  assert.equal((await issue(new PolicyFinance({ ...base, payments: uncertainGateway }), recoveryOffer, recoveryPolicy, recoveryKey)).status, 'unavailable');
  await db.query("UPDATE policy.payments SET idempotency_key='altered' WHERE policy_id=$1", [recoveryPolicy.policyId]);
  await denied(traceId => finance.charge({ actor: recoveryOffer.payload, policyId: recoveryPolicy.policyId, documentHash: recoveryPolicy.documentHash,
    idempotencyKey: `charge-${recoveryPolicy.policyId}`, traceId }), 'integrity_violation');
  await db.query("UPDATE policy.payments SET idempotency_key='initial-premium' WHERE policy_id=$1", [recoveryPolicy.policyId]);
  await assert.rejects(db.query('UPDATE policy.payments SET id=$2 WHERE policy_id=$1', [recoveryPolicy.policyId, randomUUID()]), error => (error as { code?: string }).code === '23503');
  await db.query('UPDATE policy.payments SET amount=1 WHERE policy_id=$1', [recoveryPolicy.policyId]);
  await denied(traceId => finance.charge({ actor: recoveryOffer.payload, policyId: recoveryPolicy.policyId, documentHash: recoveryPolicy.documentHash,
    idempotencyKey: `charge-${recoveryPolicy.policyId}`, traceId }), 'integrity_violation');
  await db.query('UPDATE policy.payments SET amount=$2 WHERE policy_id=$1', [recoveryPolicy.policyId, recoveryOffer.payload.premium]);
  assert.equal(ok(await issue(new PolicyFinance({ ...base, payments: new SqlMockPaymentGateway(runtime.toString()) }), recoveryOffer, recoveryPolicy, recoveryKey)).policy.status, 'issued');
  assert.deepEqual((await captures(recoveryPolicy.policyId, 'premium.confirmed'))[0].sources.map(source => [source.operation, source.result]),
    [['lookup', 'confirmed']], 'recovery records actual lookup proof without inventing another settlement');
  assert.equal(Number((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [recoveryPolicy.policyId])).rows[0].n), 1);
  const afterCharge = await acceptedOffer(); const afterChargePolicy = await importOffer(afterCharge); const afterChargeKey = randomUUID();
  const signatureProvider = new MockSignatureProvider(financialIntegrity);
  const interruptedSignature: SignatureProvider = { async sign(id, hash) {
    const result = await signatureProvider.sign(id, hash);
    await db!.query('REVOKE INSERT ON policy.outbox_events FROM solventa_local_policy');
    return result;
  } };
  try { assert.equal((await issue(new PolicyFinance({ ...base, signatures: interruptedSignature }), afterCharge, afterChargePolicy, afterChargeKey)).status, 'unavailable'); }
  finally { await db.query('GRANT INSERT ON policy.outbox_events TO solventa_local_policy'); }
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [afterChargePolicy.policyId])).rows[0].status, 'charged');
  assert.equal(Number((await db.query('SELECT count(*)::INT4 AS n FROM policy.policy_signatures WHERE policy_id=$1', [afterChargePolicy.policyId])).rows[0].n), 0);
  assert.equal(ok(await issue(new PolicyFinance(base), afterCharge, afterChargePolicy, afterChargeKey)).policy.status, 'issued');
  assert.equal(Number((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [afterChargePolicy.policyId])).rows[0].n), 1);

  for (const permission of [{ table: 'payments', privilege: 'UPDATE' }, { table: 'policies', privilege: 'UPDATE' },
    { table: 'audit_events', privilege: 'INSERT' }, { table: 'outbox_events', privilege: 'INSERT' }]) {
    const event = await acceptedOffer(), candidate = await importOffer(event), key = randomUUID();
    const interrupted: PaymentGateway = { lookup: input => gateway.lookup(input), refund: input => gateway.refund(input),
      async settle(input) {
        const result = await gateway.settle(input);
        await db!.query(`REVOKE ${permission.privilege} ON policy.${permission.table} FROM solventa_local_policy`);
        return result;
      } };
    try { assert.equal((await issue(new PolicyFinance({ ...base, payments: interrupted }), event, candidate, key)).status, 'unavailable'); }
    finally { await db.query(`GRANT ${permission.privilege} ON policy.${permission.table} TO solventa_local_policy`); }
    const rolledBack = (await db.query(`SELECT p.status,
      (SELECT status FROM policy.payments WHERE policy_id=p.id AND operation='premium') AS premium,
      (SELECT count(*)::INT4 FROM policy.audit_events WHERE resource_id=p.id AND action='premium.confirmed') AS audit,
      (SELECT count(*)::INT4 FROM policy.outbox_events WHERE aggregate_id=p.id AND event_type='policy.premium.confirmed') AS outbox,
      (SELECT count(*)::INT4 FROM policy.financial_commands WHERE policy_id=p.id AND result IS NOT NULL) AS completed
      FROM policy.policies p WHERE p.id=$1`, [candidate.policyId])).rows[0];
    assert.deepEqual(rolledBack, { status: 'pending', premium: 'pending', audit: 0, outbox: 0, completed: 0 }, permission.table);
    assert.equal(ok(await issue(new PolicyFinance(base), event, candidate, key)).policy.status, 'issued');
    assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)',
      [candidate.policyId])).rows[0].n, 1, 'confirmation recovery reconciles the existing provider effect');
  }
  for (const permission of [{ table: 'policy_signatures', privilege: 'INSERT' }, { table: 'policies', privilege: 'UPDATE' },
    { table: 'audit_events', privilege: 'INSERT' }, { table: 'outbox_events', privilege: 'INSERT' }, { table: 'financial_commands', privilege: 'UPDATE' }]) {
    const event = await acceptedOffer(), candidate = await importOffer(event), key = randomUUID();
    const interrupted: SignatureProvider = { async sign(id, hash) {
      const signed = await signatureProvider.sign(id, hash);
      await db!.query(`REVOKE ${permission.privilege} ON policy.${permission.table} FROM solventa_local_policy`);
      return signed;
    } };
    try { assert.equal((await issue(new PolicyFinance({ ...base, signatures: interrupted }), event, candidate, key)).status, 'unavailable'); }
    finally { await db.query(`GRANT ${permission.privilege} ON policy.${permission.table} TO solventa_local_policy`); }
    const rolledBack = (await db.query(`SELECT p.status,
      (SELECT count(*)::INT4 FROM policy.policy_signatures WHERE policy_id=p.id) AS signatures,
      (SELECT count(*)::INT4 FROM policy.audit_events WHERE resource_id=p.id AND action='policy.issued') AS audit,
      (SELECT count(*)::INT4 FROM policy.outbox_events WHERE aggregate_id=p.id AND event_type='policy.policy.issued') AS outbox,
      (SELECT count(*)::INT4 FROM policy.financial_commands WHERE policy_id=p.id AND result IS NOT NULL) AS completed
      FROM policy.policies p WHERE p.id=$1`, [candidate.policyId])).rows[0];
    assert.deepEqual(rolledBack, { status: 'charged', signatures: 0, audit: 0, outbox: 0, completed: 0 }, permission.table);
    assert.equal(ok(await issue(new PolicyFinance(base), event, candidate, key)).policy.status, 'issued');
    assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)',
      [candidate.policyId])).rows[0].n, 1, 'final recovery reuses the confirmed premium');
  }

  const failedSignature: SignatureProvider = { async sign() { return { status: 'failed' }; } };
  const refused = await acceptedOffer(); const refusedPolicy = await importOffer(refused);
  const refusal = await issue(new PolicyFinance({ ...base, signatures: failedSignature }), refused, refusedPolicy);
  assert.ok(refusal.status === 'denied' && refusal.error === 'signature_failed', JSON.stringify({ status: refusal.status, error: refusal.status === 'ok' ? null : refusal.error }));
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [refusedPolicy.policyId])).rows[0].status, 'refunded');
  assert.equal((await db.query('SELECT status FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [refusedPolicy.policyId])).rows[0].status, 'refunded');
  const refundedPremium = (await store.readPolicy(refusedPolicy.policyId, refused.payload))?.premium;
  assert.ok(refundedPremium);
  assert.deepEqual(await gateway.settle(refundedPremium), { status: 'declined', reference: 'MOCK-' + refundedPremium.id });
  assert.equal((await gateway.lookup(refundedPremium)).status, 'refunded', 'settlement replay cannot reverse a recorded refund');
  assert.equal(Number((await db.query('SELECT count(*)::INT4 AS n FROM policy.policy_signatures WHERE policy_id=$1', [refusedPolicy.policyId])).rows[0].n), 0);
  const refusedCaptures = { confirmed: (await captures(refusedPolicy.policyId, 'premium.confirmed'))[0],
    requested: (await captures(refusedPolicy.policyId, 'premium.refund_requested'))[0], refunded: (await captures(refusedPolicy.policyId, 'premium.refunded'))[0] };
  assert.equal(refusedCaptures.requested.inputs.refundReason, 'signature_refused');
  assert.deepEqual(refusedCaptures.requested.sources.map(source => [source.operation, source.result]), [['sign', 'failed']]);
  assert.equal(refusedCaptures.confirmed.sources.at(-1)?.result, 'confirmed', 'later provider refund cannot rewrite historical confirmation');
  assert.deepEqual(refusedCaptures.refunded.sources.map(source => [source.operation, source.result]), [['lookup', 'confirmed'], ['refund', 'refunded']]);
  let signatureClock = financialNow();
  const expiringGateway: PaymentGateway = { lookup: payment => gateway.lookup(payment), refund: payment => gateway.refund(payment),
    async settle(payment) { const result = await gateway.settle(payment); signatureClock = new Date('2026-10-16T02:16:00.000Z'); return result; } };
  const expiring = await acceptedOffer(); const expiringPolicy = await importOffer(expiring);
  const expiredSignature = await issue(new PolicyFinance({ ...base, payments: expiringGateway, now: () => signatureClock }), expiring, expiringPolicy);
  assert.ok(expiredSignature.status === 'denied' && expiredSignature.error === 'signature_failed', JSON.stringify({ status: expiredSignature.status, error: expiredSignature.status === 'ok' ? null : expiredSignature.error }));
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [expiringPolicy.policyId])).rows[0].status, 'refunded');
  const expiredCapture = (await captures(expiringPolicy.policyId, 'premium.refund_requested'))[0];
  assert.equal(expiredCapture.inputs.refundReason, 'expired_before_sign');
  assert.deepEqual(expiredCapture.sources, [], 'expiry before sign must not invent a signature consultation');
  const finalLockOffer = await acceptedOffer(); const finalLockPolicy = await importOffer(finalLockOffer);
  let finalLockClock = financialNow(), finalTransactions = 0;
  const finalLockStore: FinancialStore = {
    readPolicy: (id, actor) => store.readPolicy(id, actor), readAcceptedPolicy: (id, actor) => store.readAcceptedPolicy(id, actor),
    importAcceptance: (policy, event, trace, capture) => store.importAcceptance(policy, event, trace, capture), rejection: (id, trace, cause, capture) => store.rejection(id, trace, cause, capture),
    issuanceCandidates: (staleBefore, limit) => store.issuanceCandidates(staleBefore, limit),
    transaction: work => store.transaction(tx => {
      const transactionNumber = ++finalTransactions;
      return work(new Proxy(tx, { get(target, key) {
        if (key === 'policy') return async (id: string) => {
          const locked = await target.policy(id);
          if (transactionNumber === 7) finalLockClock = new Date(finalLockOffer.payload.expiresAt);
          return locked;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } }));
    }) };
  const finalLockResult = await issue(new PolicyFinance({ ...base, store: finalLockStore, now: () => finalLockClock }), finalLockOffer, finalLockPolicy);
  assert.ok(finalLockResult.status === 'denied' && finalLockResult.error === 'signature_failed', JSON.stringify({ status: finalLockResult.status, error: finalLockResult.status === 'ok' ? null : finalLockResult.error }));
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [finalLockPolicy.policyId])).rows[0].status, 'refunded');
  assert.equal((await db.query('SELECT status FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [finalLockPolicy.policyId])).rows[0].status, 'refunded');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.policy_signatures WHERE policy_id=$1', [finalLockPolicy.policyId])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE resource_id=$1 AND action='policy.issued'", [finalLockPolicy.policyId])).rows[0].n, 0);
  let uncertainRefund = true;
  const refundGateway: PaymentGateway = { lookup: payment => gateway.lookup(payment), settle: payment => gateway.settle(payment),
    async refund(payment) { const result = await gateway.refund(payment); if (uncertainRefund) { uncertainRefund = false; return { status: 'uncertain', reference: null }; } return result; } };
  const refundRecovery = await acceptedOffer(); const refundRecoveryPolicy = await importOffer(refundRecovery); const refundRecoveryKey = randomUUID();
  assert.equal((await issue(new PolicyFinance({ ...base, payments: refundGateway, signatures: failedSignature }), refundRecovery, refundRecoveryPolicy, refundRecoveryKey)).status, 'unavailable');
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [refundRecoveryPolicy.policyId])).rows[0].status, 'refunding');
  const recoveredRefund = await issue(new PolicyFinance(base), refundRecovery, refundRecoveryPolicy, refundRecoveryKey);
  assert.ok(recoveredRefund.status === 'denied' && recoveredRefund.error === 'signature_failed');
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [refundRecoveryPolicy.policyId])).rows[0].status, 'refunded');
  assert.equal((await captures(refundRecoveryPolicy.policyId, 'premium.refund_requested')).length, 1, 'recovery preserves the original refund decision');
  const recoveredRefundCapture = (await captures(refundRecoveryPolicy.policyId, 'premium.refunded'))[0];
  assert.equal(recoveredRefundCapture.inputs.refundReason, 'existing_refund_intent');
  assert.deepEqual(recoveredRefundCapture.sources.map(source => [source.operation, source.result]), [['lookup', 'refunded'], ['refund', 'refunded']]);

  // Autonomous recovery: the customer never retries. Other leftover candidates may be processed; only these policies are asserted.
  const stateOf = async (policyId: string) => (await db.query(`SELECT p.status,
    (SELECT count(*)::INT4 FROM policy.mock_gateway_operations g JOIN policy.payments pay ON pay.id=g.payment_id WHERE pay.policy_id=p.id) AS charges,
    (SELECT g.status FROM policy.mock_gateway_operations g JOIN policy.payments pay ON pay.id=g.payment_id WHERE pay.policy_id=p.id) AS provider,
    (SELECT count(*)::INT4 FROM policy.policy_signatures WHERE policy_id=p.id) AS signatures,
    (SELECT count(*)::INT4 FROM policy.audit_events WHERE resource_id=p.id AND action='policy.issued') AS issued,
    (SELECT count(*)::INT4 FROM policy.financial_commands WHERE policy_id=p.id AND result IS NULL) AS open
    FROM policy.policies p WHERE p.id=$1`, [policyId])).rows[0];
  const recoverAll = (service: PolicyFinance) => service.reconcileIssuances(new Date(Date.now() + 60000), 100);
  const chargedWithoutIssuance = async () => {
    const event = await acceptedOffer(), candidate = await importOffer(event);
    const commandKey = randomUUID();
    const lostEmission: SignatureProvider = { async sign(id, hash) {
      const signed = await signatureProvider.sign(id, hash);
      await db!.query('REVOKE INSERT ON policy.outbox_events FROM solventa_local_policy');
      return signed;
    } };
    try { assert.equal((await issue(new PolicyFinance({ ...base, signatures: lostEmission }), event, candidate, commandKey)).status, 'unavailable'); }
    finally { await db!.query('GRANT INSERT ON policy.outbox_events TO solventa_local_policy'); }
    assert.equal((await stateOf(candidate.policyId)).status, 'charged');
    return { event, candidate, commandKey };
  };
  const stranded = await chargedWithoutIssuance();
  await recoverAll(finance);
  assert.deepEqual(await stateOf(stranded.candidate.policyId), { status: 'issued', charges: 1, provider: 'confirmed', signatures: 1, issued: 1, open: 0 });
  assert.equal((await captures(stranded.candidate.policyId, 'policy.issued'))[0].inputs.trigger, 'reconciliation');
  const strandedRead = ok(await finance.get({ actor: stranded.event.payload, policyId: stranded.candidate.policyId, traceId: randomUUID() }));
  const strandedPayment = (await db.query("SELECT id FROM policy.payments WHERE policy_id=$1 AND operation='premium'", [stranded.candidate.policyId])).rows[0].id;
  assert.deepEqual(strandedRead.payment, { status: 'confirmed', reference: 'MOCK-' + strandedPayment }, 'the read exposes the recovered receipt');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.financial_commands WHERE policy_id=$1 AND result ? $2', [stranded.candidate.policyId, 'payment'])).rows[0].n, 0,
    'stored command results keep their replay shape');
  await recoverAll(finance);
  assert.deepEqual(await stateOf(stranded.candidate.policyId), { status: 'issued', charges: 1, provider: 'confirmed', signatures: 1, issued: 1, open: 0 }, 'a later run changes nothing');
  assert.equal(ok(await issue(finance, stranded.event, stranded.candidate)).policy.status, 'issued', 'a late client retry with a new key sees the same issuance');
  assert.equal((await stateOf(stranded.candidate.policyId)).charges, 1);
  let lostResponse = true;
  const lostConfirmation: PaymentGateway = { lookup: payment => gateway.lookup(payment), refund: payment => gateway.refund(payment),
    async settle(payment) { const result = await gateway.settle(payment); if (lostResponse) { lostResponse = false; return { status: 'uncertain', reference: null }; } return result; } };
  const unrecorded = await acceptedOffer(), unrecordedPolicy = await importOffer(unrecorded);
  assert.equal((await issue(new PolicyFinance({ ...base, payments: lostConfirmation }), unrecorded, unrecordedPolicy)).status, 'unavailable');
  assert.equal((await stateOf(unrecordedPolicy.policyId)).status, 'pending');
  await recoverAll(finance);
  assert.deepEqual(await stateOf(unrecordedPolicy.policyId), { status: 'charged', charges: 1, provider: 'confirmed', signatures: 0, issued: 0, open: 1 },
    'charge reconciliation confirms payment without signing on behalf of the customer');
  const recoveredConfirmation = (await captures(unrecordedPolicy.policyId, 'premium.confirmed'))[0];
  assert.deepEqual(recoveredConfirmation.sources.map(source => [source.operation, source.result]), [['lookup', 'confirmed']]);
  assert.equal(recoveredConfirmation.inputs.trigger, 'reconciliation');
  assert.equal(ok(await issue(finance, unrecorded, unrecordedPolicy)).policy.status, 'issued');
  const expiredCharge = await chargedWithoutIssuance();
  await recoverAll(new PolicyFinance({ ...base, now: () => new Date(expiredCharge.event.payload.expiresAt) }));
  await recoverAll(finance);
  assert.deepEqual(await stateOf(expiredCharge.candidate.policyId), { status: 'refunded', charges: 1, provider: 'refunded', signatures: 0, issued: 0, open: 0 });
  const expiredRefund = (await captures(expiredCharge.candidate.policyId, 'premium.refund_requested'))[0];
  assert.equal(expiredRefund.inputs.refundReason, 'expired_before_sign');
  assert.equal(expiredRefund.inputs.trigger, 'reconciliation');
  const refundChargeEvent = await acceptedOffer(), refundChargePolicy = await importOffer(refundChargeEvent);
  const refundChargeActor = { clientId: refundChargeEvent.payload.clientId, subjectToken: refundChargeEvent.payload.subjectToken };
  const refundChargeKey = randomUUID();
  const chargeExpiring = (service: PolicyFinance) => service.charge({ actor: refundChargeActor, policyId: refundChargePolicy.policyId,
    documentHash: refundChargePolicy.documentHash, idempotencyKey: refundChargeKey, traceId: randomUUID() });
  assert.equal(ok(await chargeExpiring(finance)).policy.status, 'charged');
  let refundUncertain = true;
  const uncertainChargeRefund: PaymentGateway = { lookup: payment => gateway.lookup(payment), settle: payment => gateway.settle(payment),
    async refund(payment) {
      const result = await gateway.refund(payment);
      if (refundUncertain) { refundUncertain = false; return { status: 'uncertain', reference: null }; }
      return result;
    } };
  const expiredClock = () => new Date(refundChargeEvent.payload.expiresAt);
  assert.equal((await chargeExpiring(new PolicyFinance({ ...base, now: expiredClock, payments: uncertainChargeRefund }))).status, 'unavailable');
  assert.equal((await stateOf(refundChargePolicy.policyId)).status, 'refunding');
  const recoveredChargeRefund = await chargeExpiring(new PolicyFinance({ ...base, now: expiredClock }));
  assert.ok(recoveredChargeRefund.status === 'denied' && recoveredChargeRefund.error === 'signature_failed');
  await recoverAll(finance);
  assert.deepEqual(await stateOf(refundChargePolicy.policyId), { status: 'refunded', charges: 1, provider: 'refunded', signatures: 0, issued: 0, open: 0 });
  const raced = await chargedWithoutIssuance();
  const [raceRecovery, raceRetry] = await Promise.all([recoverAll(finance), issue(finance, raced.event, raced.candidate, raced.commandKey)]);
  assert.ok(raceRecovery.every(outcome => outcome.outcome !== 'unavailable'), JSON.stringify(raceRecovery));
  assert.equal(ok(raceRetry).policy.status, 'issued');
  assert.deepEqual(await stateOf(raced.candidate.policyId), { status: 'issued', charges: 1, provider: 'confirmed', signatures: 1, issued: 1, open: 0 },
    'recovery racing a client retry signs, issues and charges once');

  // Old unresolved intents must remain eligible, and an unchanged batch must not starve later charges.
  const unacknowledged: PaymentGateway = { lookup: payment => gateway.lookup(payment), refund: payment => gateway.refund(payment),
    async settle() { return { status: 'uncertain', reference: null }; } };
  const aged: string[] = [];
  for (let index = 0; index < 3; index++) {
    const event = await acceptedOffer(), candidate = await importOffer(event);
    lostResponse = true;
    const payments = index === 2 ? lostConfirmation : unacknowledged;
    assert.equal((await issue(new PolicyFinance({ ...base, payments }), event, candidate)).status, 'unavailable');
    const changedAt = new Date(Date.now() - (4 - index) * 86_400_000).toISOString();
    await db.query('UPDATE policy.policies SET updated_at=$2 WHERE id=$1', [candidate.policyId, changedAt]);
    await db.query("UPDATE policy.payments SET updated_at=$2 WHERE policy_id=$1 AND operation='premium'", [candidate.policyId, changedAt]);
    aged.push(candidate.policyId);
  }
  for (const policyId of aged) {
    const selected = await store.issuanceCandidates(new Date(Date.now() - 120_000), 1);
    assert.deepEqual(selected.map(candidate => candidate.policyId), [policyId], 'old intents rotate through the bounded recovery batch');
  }
  await recoverAll(finance);
  assert.equal((await stateOf(aged[0])).charges, 0, 'recovery must not charge an unresolved intent the provider never received');
  assert.equal((await stateOf(aged[1])).charges, 0);
  assert.deepEqual(await stateOf(aged[2]), { status: 'charged', charges: 1, provider: 'confirmed', signatures: 0, issued: 0, open: 1 },
    'a provider charge with an unrecorded confirmation remains recoverable after more than a day without signing');

  const flight = await acceptedOffer('flight_delay'); const flightPolicy = await importOffer(flight);
  assert.equal(ok(await issue(finance, flight, flightPolicy)).policy.status, 'issued');
  assert.equal(flight.payload.coverage.kind, 'flight_delay');
  if (flight.payload.coverage.kind !== 'flight_delay') throw new Error('unexpected_fixture');
  const event = await flightEvent(flightPolicy.policyId, flight.payload.coverage.flightReference);
  const changed = { ...event, payload: { ...event.payload, delayMinutes: 181 } };
  await denied(traceId => finance.consumeParametricEvent(changed, traceId), 'invalid_event');
  const indemnityTables = ['claims', 'indemnities', 'payments', 'financial_payment_intents', 'inbox_events', 'audit_events', 'outbox_events', 'mock_gateway_operations'];
  const beforeIndemnityFailure = await counts(indemnityTables);
  await db.query('REVOKE INSERT ON policy.financial_payment_intents FROM solventa_local_policy');
  try { assert.equal((await finance.consumeParametricEvent(event, randomUUID())).status, 'unavailable'); }
  finally { await db.query('GRANT INSERT ON policy.financial_payment_intents TO solventa_local_policy'); }
  assert.deepEqual(await counts(indemnityTables), beforeIndemnityFailure,
    'a failed immutable intent insert must roll back the claim, indemnity, payment, inbox and audit before any provider call');
  assert.equal(ok(await finance.consumeParametricEvent(event, randomUUID())).replayed, false);
  const paidClaim = (await db.query('SELECT id,status,version FROM policy.claims WHERE policy_id=$1', [flightPolicy.policyId])).rows[0];
  assert.equal(paidClaim.status, 'paid');
  assert.equal(Number(paidClaim.version), 2);
  assert.equal((await db.query('SELECT status FROM policy.indemnities WHERE policy_id=$1', [flightPolicy.policyId])).rows[0].status, 'paid');
  assert.equal(ok(await new PolicyFinance(base).consumeParametricEvent(event, randomUUID())).replayed, true);
  changed.signature = await financialIntegrity.digest(eventContent(changed));
  await denied(traceId => finance.consumeParametricEvent(changed, traceId), 'event_conflict');
  const secondEvent = { ...event, eventId: randomUUID() }; secondEvent.signature = await financialIntegrity.digest(eventContent(secondEvent));
  await denied(traceId => finance.consumeParametricEvent(secondEvent, traceId), 'event_conflict');
  assert.equal(Number((await db.query("SELECT count(*)::INT4 AS n FROM policy.payments WHERE policy_id=$1 AND operation='indemnity'", [flightPolicy.policyId])).rows[0].n), 1);
  const parametricCapture = (await captures(flightPolicy.policyId, 'parametric.accepted'))[0];
  assert.deepEqual(parametricCapture.inputs.event, { eventId: event.eventId, eventType: event.eventType, environment: 'local', occurredAt: event.occurredAt, delayMinutes: 180 });
  assert.deepEqual(parametricCapture.inputs.issuance, { signedAt: financialNow().toISOString(), documentHash: flightPolicy.documentHash });
  assert.deepEqual(parametricCapture.sources, [{ source: 'synthetic-oracle-v1', capturedAt: financialNow().toISOString(), quality: 'synthetic_verified',
    degraded: false, operation: 'consume', result: 'authenticated', eventId: event.eventId, occurredAt: event.occurredAt }]);
  assert.deepEqual((await captures(flightPolicy.policyId, 'indemnity.confirmed'))[0].sources.map(source => [source.source, source.operation, source.result]),
    [['synthetic-oracle-v1', 'consume', 'authenticated'], ['synthetic-gateway-v1', 'lookup', 'unknown'], ['synthetic-gateway-v1', 'settle', 'confirmed']]);
  assert.equal((await captures(flightPolicy.policyId, 'parametric.accepted')).length, 1);
  assert.equal((await captures(flightPolicy.policyId, 'indemnity.confirmed')).length, 1, 'event replay cannot duplicate historical decisions');
  const laterFlight = await acceptedOffer('flight_delay'); const laterPolicy = await importOffer(laterFlight);
  const issuedAt = '2026-10-16T02:01:00.000Z';
  const laterService = new PolicyFinance({ ...base, now: () => new Date(issuedAt) });
  assert.equal(ok(await issue(laterService, laterFlight, laterPolicy)).policy.status, 'issued');
  assert.deepEqual((await db.query('SELECT id,status,version FROM policy.claims WHERE policy_id=$1', [flightPolicy.policyId])).rows[0], paidClaim,
    'confirming an unrelated premium must not change a paid indemnity claim or its version');
  const orphanIndemnityOffer = await acceptedOffer('flight_delay'); const orphanIndemnityPolicy = await importOffer(orphanIndemnityOffer);
  assert.equal(ok(await issue(finance, orphanIndemnityOffer, orphanIndemnityPolicy)).policy.status, 'issued');
  if (orphanIndemnityOffer.payload.coverage.kind !== 'flight_delay') throw new Error('unexpected_fixture');
  const orphanClaimId = randomUUID(), orphanIndemnityId = randomUUID(), orphanTrace = randomUUID();
  await db.query(`INSERT INTO policy.claims(id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id)
    VALUES($1,$2,'parametric-once',$3,'approved',$4,$5)`,
  [orphanClaimId, orphanIndemnityPolicy.policyId, '0'.repeat(64), financialNow().toISOString(), orphanTrace]);
  await db.query(`INSERT INTO policy.indemnities(id,claim_id,policy_id,amount,currency,status,correlation_id)
    VALUES($1,$2,$3,$4,'COP','pending',$5)`,
  [orphanIndemnityId, orphanClaimId, orphanIndemnityPolicy.policyId, orphanIndemnityOffer.payload.coverage.payoutAmount, orphanTrace]);
  await db.query(`INSERT INTO policy.payments(id,policy_id,indemnity_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
    VALUES($1,$2,$3,'indemnity','parametric-once',$4,$5,'COP','pending',$6)`,
  [randomUUID(), orphanIndemnityPolicy.policyId, orphanIndemnityId, '0'.repeat(64), orphanIndemnityOffer.payload.coverage.payoutAmount, orphanTrace]);
  const orphanEvent = await flightEvent(orphanIndemnityPolicy.policyId, orphanIndemnityOffer.payload.coverage.flightReference);
  const orphanCounts = await counts(['claims', 'indemnities', 'payments']);
  await denied(traceId => finance.consumeParametricEvent(orphanEvent, traceId), 'integrity_violation');
  assert.deepEqual(await counts(['claims', 'indemnities', 'payments']), orphanCounts,
    'an orphan indemnity must be detected even when the issued policy already has a valid premium intent');
  if (laterFlight.payload.coverage.kind !== 'flight_delay') throw new Error('unexpected_fixture');
  const beforeIssuance = await flightEvent(laterPolicy.policyId, laterFlight.payload.coverage.flightReference);
  await denied(traceId => laterService.consumeParametricEvent(beforeIssuance, traceId), 'event_not_covered');
  assert.equal(Number((await db.query("SELECT count(*)::INT4 AS n FROM policy.payments WHERE policy_id=$1 AND operation='indemnity'", [laterPolicy.policyId])).rows[0].n), 0);
  const coveredOccurrence = { ...beforeIssuance, occurredAt: issuedAt };
  coveredOccurrence.signature = await financialIntegrity.digest(eventContent(coveredOccurrence));
  assert.equal(ok(await laterService.consumeParametricEvent(coveredOccurrence, randomUUID())).policy.status, 'issued');
  await db.query('UPDATE policy.policy_signatures SET signed_at=$2 WHERE policy_id=$1', [laterPolicy.policyId, financialNow().toISOString()]);
  await denied(traceId => laterService.get({ actor: laterFlight.payload, policyId: laterPolicy.policyId, traceId }), 'integrity_violation');
  await db.query('UPDATE policy.policy_signatures SET signed_at=$2 WHERE policy_id=$1', [laterPolicy.policyId, issuedAt]);
  const savedSeal = (await db.query('SELECT time_seal FROM policy.policy_signatures WHERE policy_id=$1', [laterPolicy.policyId])).rows[0].time_seal;
  const deadlineSeal = await financialIntegrity.digest(issuanceTimeContent(laterPolicy.policyId, laterPolicy.documentHash, laterFlight.payload.expiresAt));
  await db.query('UPDATE policy.policy_signatures SET signed_at=$2,time_seal=$3 WHERE policy_id=$1', [laterPolicy.policyId, laterFlight.payload.expiresAt, deadlineSeal]);
  await denied(traceId => laterService.get({ actor: laterFlight.payload, policyId: laterPolicy.policyId, traceId }), 'integrity_violation');
  await db.query('UPDATE policy.policy_signatures SET signed_at=$2,time_seal=$3 WHERE policy_id=$1', [laterPolicy.policyId, issuedAt, savedSeal]);

  // A stored policy alteration is detected before the provider. Restore only this disposable fixture afterwards.
  await db.query("UPDATE policy.payments SET provider_reference='altered-reference' WHERE policy_id=$1 AND operation='premium'", [policy.policyId]);
  await denied(traceId => finance.get({ actor: offer.payload, policyId: policy.policyId, traceId }), 'integrity_violation');
  await db.query("UPDATE policy.payments SET provider_reference='MOCK-'||id::STRING WHERE policy_id=$1 AND operation='premium'", [policy.policyId]);
  const historicalIssued = (await captures(policy.policyId, 'policy.issued'))[0];
  await db.query('UPDATE policy.policies SET premium=1 WHERE id=$1', [policy.policyId]);
  assert.deepEqual((await captures(policy.policyId, 'policy.issued'))[0], historicalIssued, 'altered live premium cannot rewrite the persisted historical snapshot');
  await denied(traceId => finance.get({ actor: offer.payload, policyId: policy.policyId, traceId }), 'integrity_violation');
  await db.query('UPDATE policy.policies SET premium=$2 WHERE id=$1', [policy.policyId, offer.payload.premium]);
  const rollbackOffer = await acceptedOffer(); const beforeRollback = await count('policies');
  await db.query('REVOKE INSERT ON policy.outbox_events FROM solventa_local_policy');
  try { assert.equal((await finance.acceptOffer(rollbackOffer, randomUUID())).status, 'unavailable'); }
  finally { await db.query('GRANT INSERT ON policy.outbox_events TO solventa_local_policy'); }
  assert.equal(await count('policies'), beforeRollback, 'business effect must roll back when its outbox insert fails');
  const brokenStore: FinancialStore = {
    readPolicy: (id, actor) => store.readPolicy(id, actor), readAcceptedPolicy: (id, actor) => store.readAcceptedPolicy(id, actor),
    importAcceptance: (policy, event, trace, capture) => store.importAcceptance(policy, event, trace, capture), transaction: work => store.transaction(work),
    issuanceCandidates: (staleBefore, limit) => store.issuanceCandidates(staleBefore, limit), async rejection() { throw new Error('sql_unavailable'); } };
  assert.equal((await new PolicyFinance({ ...base, store: brokenStore }).acceptOffer({}, randomUUID())).status, 'unavailable');
  const auditRole = clientFor(runtime, config.ssl); await auditRole.connect();
  try {
    await assert.rejects(auditRole.query("UPDATE policy.audit_events SET outcome='changed'"), error => (error as { code?: string }).code === '42501');
    await assert.rejects(auditRole.query('DELETE FROM policy.inbox_events'), error => (error as { code?: string }).code === '42501');
    await assert.rejects(auditRole.query("UPDATE policy.financial_contracts SET decision_capture='{}'"), error => (error as { code?: string }).code === '42501');
    assert.equal((await auditRole.query("SELECT has_schema_privilege(current_user,'policy','CREATE') AS allowed")).rows[0].allowed, false);
  } finally { await auditRole.end(); }
  const validateCapture = new Ajv({ allErrors: true }).compile(JSON.parse(await readFile('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
  const persisted = (await db.query<{ event_type: string; payload: FinancialDecisionCapture }>('SELECT event_type,payload FROM policy.outbox_events')).rows;
  const requiredActions = ['offer.accepted', 'premium.requested', 'premium.declined', 'premium.confirmed', 'policy.issued', 'premium.refund_requested',
    'premium.refunded', 'parametric.accepted', 'indemnity.confirmed', 'signature.challenge_created',
    'signature.challenge_failed', 'signature.challenge_cancelled', 'signature.challenge_verified', 'financial.denied'];
  const expectedPaymentStatus: Record<string, string> = { 'premium.requested': 'pending', 'premium.declined': 'declined', 'premium.confirmed': 'confirmed',
    'policy.issued': 'confirmed', 'premium.refund_requested': 'confirmed', 'premium.refunded': 'refunded', 'parametric.accepted': 'pending', 'indemnity.confirmed': 'confirmed' };
  for (const action of requiredActions) assert.ok(persisted.some(row => row.event_type === 'policy.' + action), 'missing persisted decision ' + action);
  for (const row of persisted) {
    assert.equal(validateCapture(row.payload), true, JSON.stringify(validateCapture.errors));
    if (row.event_type === 'policy.financial.denied') { assert.deepEqual(Object.keys(row.payload.inputs).sort(), ['resourceId', 'synthetic']); continue; }
    const capture = row.payload, action = row.event_type.slice('policy.'.length);
    const contract: { terms: AcceptedOffer; terms_hash: string; document_hash: string; decision_capture: FinancialDecisionCapture } =
      (await db.query('SELECT terms,terms_hash,document_hash,decision_capture FROM policy.financial_contracts WHERE policy_id=$1', [capture.inputs.resourceId])).rows[0];
    const terms: AcceptedOffer = contract.terms;
    assert.deepEqual(capture.inputs.offer, { acceptanceId: terms.acceptanceId, offerId: terms.offerId, offerVersion: terms.offerVersion, product: terms.product,
      premium: terms.premium, currency: terms.currency, coverage: terms.coverage, effectiveFrom: terms.effectiveFrom, effectiveUntil: terms.effectiveUntil,
      expiresAt: terms.expiresAt, acceptedAt: terms.acceptedAt, ruleVersion: terms.ruleVersion });
    assert.equal(capture.inputs.documentHash, contract.document_hash); assert.equal(capture.inputs.termsHash, contract.terms_hash);
    assert.equal(capture.rule.id, action); assert.equal(capture.rule.version, 'academic-financial-1');
    assert.match(String(capture.inputs.evaluatedAt), /^2026-10-16T02:/);
    if (action === 'offer.accepted') {
      assert.deepEqual(contract.decision_capture, capture, 'contract and outbox must retain the same application decision');
      assert.equal(capture.sources[0].source, 'acquisition.offer-accepted.v1');
      assert.ok(capture.inputs.event && typeof capture.inputs.event === 'object');
    } else if (action.startsWith('signature.')) {
      assert.equal(capture.inputs.payment, undefined);
      const challenge = capture.inputs.challenge as { accepted: boolean; attempts: unknown };
      assert.equal(challenge.accepted, true);
      assert.ok(typeof challenge.attempts === 'number' && Number.isInteger(challenge.attempts)
        && challenge.attempts >= 0 && challenge.attempts <= 3, 'challenge history must retain a bounded numeric count');
      assert.equal(JSON.stringify(capture).includes('demoCode'), false);
    } else {
      const operation = ['parametric.accepted', 'indemnity.confirmed'].includes(action) ? 'indemnity' : 'premium';
      const payment: { id: string; amount: string; currency: string; payment_key: string; request_hash: string } =
        (await db.query('SELECT p.id,p.amount::STRING,p.currency,i.payment_key,i.request_hash FROM policy.financial_payment_intents i JOIN policy.payments p ON p.id=i.payment_id WHERE i.policy_id=$1 AND i.operation=$2', [capture.inputs.resourceId, operation])).rows[0];
      assert.ok(payment);
      assert.deepEqual(capture.inputs.payment, { paymentId: payment.id, operation, amount: payment.amount, currency: payment.currency,
        intentKey: payment.payment_key, intentHash: payment.request_hash, status: expectedPaymentStatus[action],
        providerReference: ['pending', 'declined'].includes(expectedPaymentStatus[action]) ? null : 'MOCK-' + payment.id });
      if (action === 'premium.requested') assert.deepEqual(capture.sources, [], 'no provider has been consulted when the intent is committed');
      if (action === 'premium.declined') assert.equal(capture.sources.at(-1)?.result, 'declined');
    }
    assert.equal(JSON.stringify(capture).includes(terms.clientId), false); assert.equal(JSON.stringify(capture).includes(terms.subjectToken), false);
    assert.equal(JSON.stringify(capture).includes(key), false, 'raw caller idempotency key is not historical business input');
  }
  console.log(JSON.stringify({ financialSQL: 'passed', externalProviders: 'synthetic durable SQL gateway and deterministic signature/event protocol only',
    persistedCaptureActions: requiredActions, persistedCapturesValidated: persisted.length,
    rejectionAuditVisibilityUpperBoundsMs: auditTimingsMs, checks: ['fresh_migrations_and_replay', 'runtime_owned_grants', 'immutable_offer_import', 'owned_discovery', 'committed_owned_snapshot_reads_under_writer_contention', 'document_binding',
      'signature_attempt_count_and_capture', 'three_wrong_codes_cancel_challenge', 'cancelled_and_expired_challenges_remain_unsigned',
      'altered_event_authentication', 'same_event_changed_payload', 'expired_offer_denial', 'import_contract_inbox_audit_outbox_rollback', 'replay_integrity_revalidated', 'foreign_malformed_policy_remains_opaque', 'unimported_acceptance_pending_unaudited',
      'concurrent_redelivery_single_import', 'concurrent_rival_envelope_conflict', 'orphan_payment_denied', 'indemnity_claim_confirmation_and_premium_isolation', 'idempotent_charge_and_issuance', 'concurrent_retries', 'durable_provider_restart',
      'uncertain_confirmation_reconciliation', 'premium_intent_audit_from_first_write', 'compound_initial_premium_rollback_per_table', 'premium_decline_audit_atomic', 'forged_confirmation_without_provider_proof_denied', 'altered_confirmation_reference_denied', 'immutable_provider_intent_identity', 'altered_payment_key_and_amount_denied', 'v1_legacy_issue_and_replay', 'confirmed_charge_then_emission_rollback_recovery', 'compound_confirmation_and_issuance_atomicity', 'signature_failure_refund', 'expired_signature_refund', 'expiry_after_final_lock_refund', 'autonomous_issuance_recovery', 'premium_state_read', 'autonomous_unrecorded_charge_recovery', 'autonomous_expired_charge_refund', 'charge_retry_completes_refund', 'recovery_racing_client_retry', 'persisted_signature_deadline_enforced', 'parametric_once', 'event_before_issuance_denied', 'issuance_timestamp_sealed', 'stored_policy_tamper', 'transactional_outbox_rollback', 'required_audit_failure_closed', 'runtime_audit_and_inbox_immutable'] }));
} catch (error) { testFailure = error; throw error; }
finally {
  await db?.end();
  try {
    if (created && migrationsComplete) await admin.query(`DROP DATABASE ${name} CASCADE`);
    else if (created) console.log(JSON.stringify({ financialSQL: 'migration_failed', preservedDatabase: name, reconciliationRequired: true }));
  } catch (error) {
    console.error(JSON.stringify({ financialSQL: 'cleanup_failed', preservedDatabase: name, reconciliationRequired: true }));
    // Preserve the assertion/SQL error that caused the test failure rather than masking it with cleanup.
    if (testFailure === undefined) throw error;
  } finally { await admin.end(); }
}
