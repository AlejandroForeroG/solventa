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
  const issue = (service: PolicyFinance, event: SignedOfferAcceptanceV1, policy: { policyId: string; documentHash: string }, key = randomUUID()) => service.issue({
    actor: { clientId: event.payload.clientId, subjectToken: event.payload.subjectToken }, policyId: policy.policyId, documentHash: policy.documentHash, idempotencyKey: key, traceId: randomUUID() });
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

  const offer = await acceptedOffer();
  const policy = await importOffer(offer);
  const originalCounts = await counts(['policies', 'inbox_events', 'audit_events', 'outbox_events']);
  assert.equal(ok(await finance.acceptOffer(offer, randomUUID())).replayed, true);
  assert.deepEqual(await counts(['policies', 'inbox_events', 'audit_events', 'outbox_events']), originalCounts);
  const duplicateOffer = { ...offer, eventId: randomUUID(), payload: { ...offer.payload, acceptanceId: randomUUID() } };
  duplicateOffer.signature = await financialIntegrity.digest(eventContent(duplicateOffer));
  await denied(traceId => finance.acceptOffer(duplicateOffer, traceId), 'event_conflict');
  assert.equal(ok(await finance.getByAcceptance({ actor: offer.payload, acceptanceId: offer.payload.acceptanceId, traceId: randomUUID() })).policy.policyId, policy.policyId);
  await denied(traceId => finance.get({ actor: { clientId: randomUUID(), subjectToken: randomUUID() }, policyId: policy.policyId, traceId }), 'not_found');
  await denied(traceId => finance.issue({ actor: offer.payload, policyId: policy.policyId, documentHash: '0'.repeat(64), idempotencyKey: randomUUID(), traceId }), 'document_mismatch');
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
  for (const table of ['financial_contracts', 'audit_events', 'outbox_events']) {
    await db.query(`REVOKE INSERT ON policy.${table} FROM solventa_local_policy`);
    try { assert.equal((await finance.acceptOffer(importRollback, randomUUID())).status, 'unavailable'); }
    finally { await db.query(`GRANT INSERT ON policy.${table} TO solventa_local_policy`); }
    assert.deepEqual(await counts(importTables), beforeImportFailure,
      'a failed contract/audit/outbox insert must roll back policy, contract, inbox and audit together');
  }
  assert.equal((await importOffer(importRollback)).status, 'pending');

  const orphanOffer = await acceptedOffer(); const orphanPolicy = await importOffer(orphanOffer);
  await db.query(`INSERT INTO policy.payments(id,policy_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
    VALUES($1,$2,'premium','initial-premium',$3,$4,'COP','pending',$5)`,
  [randomUUID(), orphanPolicy.policyId, '0'.repeat(64), orphanOffer.payload.premium, randomUUID()]);
  await denied(traceId => finance.issue({ actor: orphanOffer.payload, policyId: orphanPolicy.policyId, documentHash: orphanPolicy.documentHash,
    idempotencyKey: randomUUID(), traceId }), 'integrity_violation');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.financial_payment_intents WHERE policy_id=$1', [orphanPolicy.policyId])).rows[0].n, 0,
    'an orphan payment must not be hidden by the absent intent or replaced by a new premium');

  const key = randomUUID();
  const intentRollback = await acceptedOffer(); const intentRollbackPolicy = await importOffer(intentRollback); const intentRollbackKey = randomUUID();
  const beforeIntentFailure = await counts(['payments', 'financial_commands', 'mock_gateway_operations']);
  await db.query('REVOKE INSERT ON policy.outbox_events FROM solventa_local_policy');
  try { assert.equal((await issue(finance, intentRollback, intentRollbackPolicy, intentRollbackKey)).status, 'unavailable'); }
  finally { await db.query('GRANT INSERT ON policy.outbox_events TO solventa_local_policy'); }
  assert.deepEqual(await counts(['payments', 'financial_commands', 'mock_gateway_operations']), beforeIntentFailure,
    'the first premium intent, command and provider effect must not survive a failed atomic outbox write');
  assert.equal(ok(await issue(finance, intentRollback, intentRollbackPolicy, intentRollbackKey)).policy.status, 'issued');
  const noProofOffer = await acceptedOffer(); const noProofPolicy = await importOffer(noProofOffer); const noProofKey = randomUUID();
  const noProofGateway: PaymentGateway = { lookup: payment => gateway.lookup(payment), refund: payment => gateway.refund(payment),
    async settle() { return { status: 'uncertain', reference: null }; } };
  assert.equal((await issue(new PolicyFinance({ ...base, payments: noProofGateway }), noProofOffer, noProofPolicy, noProofKey)).status, 'unavailable');
  await db.query("UPDATE policy.policies SET status='charged' WHERE id=$1", [noProofPolicy.policyId]);
  await db.query("UPDATE policy.payments SET status='confirmed',provider_reference='MOCK-'||id::STRING WHERE policy_id=$1", [noProofPolicy.policyId]);
  await denied(traceId => finance.issue({ actor: noProofOffer.payload, policyId: noProofPolicy.policyId, documentHash: noProofPolicy.documentHash,
    idempotencyKey: noProofKey, traceId }), 'integrity_violation');
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
  const financialCounts = await counts(['payments', 'policy_signatures', 'mock_gateway_operations']);
  assert.equal(ok(await issue(new PolicyFinance({ ...base, payments: new SqlMockPaymentGateway(runtime.toString()) }), offer, policy, key)).replayed, true);
  assert.deepEqual(await counts(['payments', 'policy_signatures', 'mock_gateway_operations']), financialCounts);
  const sameActorOffer = await acceptedOffer();
  sameActorOffer.payload.clientId = offer.payload.clientId;
  sameActorOffer.payload.subjectToken = offer.payload.subjectToken;
  sameActorOffer.signature = await financialIntegrity.digest(eventContent(sameActorOffer));
  const sameActorPolicy = await importOffer(sameActorOffer);
  await denied(traceId => finance.issue({ actor: offer.payload, policyId: sameActorPolicy.policyId, documentHash: sameActorPolicy.documentHash, idempotencyKey: key, traceId }), 'idempotency_conflict');
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
  await denied(traceId => finance.issue({ actor: recoveryOffer.payload, policyId: recoveryPolicy.policyId, documentHash: recoveryPolicy.documentHash, idempotencyKey: recoveryKey, traceId }), 'integrity_violation');
  await db.query("UPDATE policy.payments SET idempotency_key='initial-premium' WHERE policy_id=$1", [recoveryPolicy.policyId]);
  await assert.rejects(db.query('UPDATE policy.payments SET id=$2 WHERE policy_id=$1', [recoveryPolicy.policyId, randomUUID()]), error => (error as { code?: string }).code === '23503');
  await db.query('UPDATE policy.payments SET amount=1 WHERE policy_id=$1', [recoveryPolicy.policyId]);
  await denied(traceId => finance.issue({ actor: recoveryOffer.payload, policyId: recoveryPolicy.policyId, documentHash: recoveryPolicy.documentHash, idempotencyKey: recoveryKey, traceId }), 'integrity_violation');
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

  const failedSignature: SignatureProvider = { async sign() { return { status: 'failed' }; } };
  const refused = await acceptedOffer(); const refusedPolicy = await importOffer(refused);
  const refusal = await issue(new PolicyFinance({ ...base, signatures: failedSignature }), refused, refusedPolicy);
  assert.ok(refusal.status === 'denied' && refusal.error === 'signature_failed', JSON.stringify({ status: refusal.status, error: refusal.status === 'ok' ? null : refusal.error }));
  assert.equal((await db.query('SELECT status FROM policy.policies WHERE id=$1', [refusedPolicy.policyId])).rows[0].status, 'refunded');
  assert.equal((await db.query('SELECT status FROM policy.mock_gateway_operations WHERE payment_id IN (SELECT id FROM policy.payments WHERE policy_id=$1)', [refusedPolicy.policyId])).rows[0].status, 'refunded');
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
  const finalLockStore: FinancialStore = { rejection: (id, trace, cause, capture) => store.rejection(id, trace, cause, capture),
    transaction: work => store.transaction(tx => {
      const transactionNumber = ++finalTransactions;
      return work(new Proxy(tx, { get(target, key) {
        if (key === 'policy') return async (id: string) => {
          const locked = await target.policy(id);
          if (transactionNumber === 3) finalLockClock = new Date(finalLockOffer.payload.expiresAt);
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
  const brokenStore: FinancialStore = { transaction: work => store.transaction(work), async rejection() { throw new Error('sql_unavailable'); } };
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
    'premium.refunded', 'parametric.accepted', 'indemnity.confirmed', 'financial.denied'];
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
    rejectionAuditVisibilityUpperBoundsMs: auditTimingsMs, checks: ['fresh_migrations_and_replay', 'runtime_owned_grants', 'immutable_offer_import', 'owned_discovery', 'document_binding',
      'altered_event_authentication', 'same_event_changed_payload', 'expired_offer_denial', 'import_contract_inbox_audit_outbox_rollback', 'orphan_payment_denied', 'indemnity_claim_confirmation_and_premium_isolation', 'idempotent_charge_and_issuance', 'concurrent_retries', 'durable_provider_restart',
      'uncertain_confirmation_reconciliation', 'premium_intent_audit_from_first_write', 'premium_decline_audit_atomic', 'forged_confirmation_without_provider_proof_denied', 'altered_confirmation_reference_denied', 'immutable_provider_intent_identity', 'altered_payment_key_and_amount_denied', 'confirmed_charge_then_emission_rollback_recovery', 'signature_failure_refund', 'expired_signature_refund', 'expiry_after_final_lock_refund', 'persisted_signature_deadline_enforced', 'parametric_once', 'event_before_issuance_denied', 'issuance_timestamp_sealed', 'stored_policy_tamper', 'transactional_outbox_rollback', 'required_audit_failure_closed', 'runtime_audit_and_inbox_immutable'] }));
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
