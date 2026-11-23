import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { ClaimDisbursements } from '../backend/policy-claims-payments/src/application/claim-disbursements';
import { SqlClaimDisbursements } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-disbursements';
import { SqlMockPaymentGateway } from '../backend/policy-claims-payments/src/adapters/outbound/mock-financial-providers';
import { HmacFinancialIntegrity } from '../backend/policy-claims-payments/src/adapters/outbound/financial-integrity';
import { PaymentDeadline } from '../backend/policy-claims-payments/src/adapters/outbound/disbursement-deadline';
import { issuanceTimeContent, offerContent, type AcceptedOffer } from '../backend/policy-claims-payments/src/domain/financial';
import type { DisbursementStore, DisbursementTransaction } from '../backend/policy-claims-payments/src/application/ports/claim-disbursement';
import { lifecycleContent, type LifecycleChange } from '../backend/policy-claims-payments/src/domain/policy-lifecycle';
import { ClaimReview } from '../backend/policy-claims-payments/src/application/claim-review';
import { SqlClaimReview } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-review';
import { createHttp } from '../backend/policy-claims-payments/src/adapters/inbound/http';

const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_claim_disbursement_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_claim_disbursement_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let db: ReturnType<typeof clientFor> | undefined;
let created = false, migrated = false;
try {
  await admin.connect();
  const held = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  const users = (await admin.query('SHOW USERS')).rows;
  if (!users.some(user => user.username === 'solventa_local_policy'))
    await admin.query(`CREATE USER solventa_local_policy WITH PASSWORD '${held.passwords.policy.replaceAll("'", "''")}'`);
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA policy');
  await db.query('CREATE TABLE policy.schema_migrations(version STRING PRIMARY KEY,checksum STRING NOT NULL,applied_at TIMESTAMPTZ DEFAULT now())');
  const schemaOwner = owners.find(row => row.schema === 'policy')!;
  await applyMigrations(db, schemaOwner); migrated = true;
  const grants = JSON.parse(await readFile('backend/policy-claims-payments/runtime-grants.json', 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_policy`);
  await db.query('GRANT USAGE ON SCHEMA policy TO solventa_local_policy');
  await applyRuntimeGrants(db, schemaOwner, 'solventa_local_policy', grants);
  const runtime = new URL(url); runtime.username = 'solventa_local_policy'; runtime.password = held.passwords.policy;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const connection = runtime.toString();
  const integrity = new HmacFinancialIntegrity('a'.repeat(64));
  const analyst = randomUUID(), analystSubject = randomUUID(), customer = randomUUID(), subject = randomUUID(), policyId = randomUUID();
  const documentHash = 'd'.repeat(64), issuedAt = '2026-01-01T00:00:02.000Z';
  const offer: AcceptedOffer = { acceptanceId: randomUUID(), offerId: randomUUID(), offerVersion: 1, clientId: customer, subjectToken: subject,
    product: 'vida_hipotecario', premium: '100.0000', currency: 'COP', coverage: { kind: 'mortgage_life', sumInsured: '100000.0000' },
    effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: '2027-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z',
    acceptedAt: '2026-01-01T00:00:01.000Z', ruleVersion: 'academic-financial-1' };
  const seedPolicy = async (selectedPolicyId = policyId, selectedOffer = offer) => {
  await db!.query(`INSERT INTO policy.policies(id,subject_token,offer_id,offer_version,idempotency_key,request_hash,status,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id)
    VALUES($1,$2,$3,1,$1::STRING,$4,'issued',100,'COP',$5,$6,$7,$8)`,
  [selectedPolicyId, subject, selectedOffer.offerId, 'a'.repeat(64), JSON.stringify(selectedOffer.coverage), selectedOffer.effectiveFrom, selectedOffer.effectiveUntil, randomUUID()]);
  await db!.query(`INSERT INTO policy.financial_contracts(policy_id,client_id,acceptance_id,acceptance_event_id,terms,terms_hash,document,document_hash,decision_capture)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic document',$7,'{}')`,
  [selectedPolicyId, customer, selectedOffer.acceptanceId, randomUUID(), JSON.stringify(selectedOffer), await integrity.digest(offerContent(selectedOffer)), documentHash]);
  await db!.query(`INSERT INTO policy.policy_signatures(policy_id,document_hash,provider,receipt,signed_at,time_seal)
    VALUES($1,$2,'synthetic-signature-v1',$3,$4,$5)`, [selectedPolicyId, documentHash,
    await integrity.digest(JSON.stringify(['mock-signature-v1', selectedPolicyId, documentHash])), issuedAt,
    await integrity.digest(issuanceTimeContent(selectedPolicyId, documentHash, issuedAt))]);
  const premium = randomUUID();
  await db!.query(`INSERT INTO policy.payments(id,policy_id,operation,idempotency_key,request_hash,amount,currency,status,correlation_id)
    VALUES($1,$2,'premium','initial-premium',$3,100,'COP','confirmed',$4)`, [premium, selectedPolicyId, 'b'.repeat(64), randomUUID()]);
  await db!.query(`INSERT INTO policy.financial_payment_intents(policy_id,operation,payment_id,payment_key,request_hash)
    VALUES($1,'premium',$2,'initial-premium',$3)`, [selectedPolicyId, premium, 'b'.repeat(64)]);
  };
  await seedPolicy();
  let sequence = 0;
  const seed = async (status = 'approved', selectedPolicyId = policyId, occurredAt = '2026-11-01T00:00:00.000Z') => {
    const claimId = randomUUID(), decisionId = randomUUID(); sequence++;
    await db!.query(`INSERT INTO policy.claims(id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id,claim_number,submitted_at,assignee_id)
      VALUES($1,$2,$1::STRING,$3,$4,$8,$5,$6,now(),$7)`,
    [claimId, selectedPolicyId, 'c'.repeat(64), status, randomUUID(), 'SIN-2026-' + String(sequence).padStart(5, '0'), analyst, occurredAt]);
    await db!.query(`INSERT INTO policy.claim_decisions(id,claim_id,actor_id,idempotency_key_hash,request_hash,action,previous_state,resulting_state,reason,evidence_ids,decision_capture,correlation_id)
      VALUES($1,$2,$3,$4,$4,'approve','in_review','approved','Synthetic verified approval','[]','{}',$5)`,
    [decisionId, claimId, analyst, 'e'.repeat(64), randomUUID()]);
    return claimId;
  };
  const actor = () => ({ clientId: analyst, subjectToken: analystSubject, traceId: randomUUID(), expiresAt: new Date(Date.now() + 5000).toISOString() });
  const store = new SqlClaimDisbursements(connection), gateway = new SqlMockPaymentGateway(connection);
  const create = (selected: DisbursementStore = store) => new ClaimDisbursements(selected, gateway, integrity, new PaymentDeadline(), { now: () => new Date(), newId: randomUUID }, true);
  const service = create();
  const claimId = await seed();
  assert.deepEqual(await service.request(claimId, { amount: '1000.0000' }, { ...actor(), clientId: randomUUID() }), { status: 'not_found' });
  assert.deepEqual(await service.request(claimId, { amount: '1000.0000' }, { ...actor(), subjectToken: subject }), { status: 'not_found' });
  await assert.rejects(service.request(claimId, { amount: '1000.0000' }, { ...actor(), expiresAt: new Date(0).toISOString() }), /authorization_expired/);
  const first = await service.request(claimId, { amount: '1000.0000' }, actor());
  assert.equal(first.status, 'ok'); if (first.status !== 'ok') throw Error('intent_not_created');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations')).rows[0].n, 0);
  const concurrent = await Promise.all([service.request(claimId, { amount: '1000.0000' }, actor()), service.request(claimId, { amount: '1000.0000' }, actor())]);
  assert.ok(concurrent.every(result => result.status === 'ok' && result.payment.paymentId === first.payment.paymentId && result.replayed));
  assert.deepEqual(await service.request(claimId, { amount: '1001.0000' }, actor()), { status: 'conflict' });

  // Fail the real owner commit after provider confirmation; the transaction must roll back all local terminal writes.
  const failAfterFinish: DisbursementStore = { candidates: limit => store.candidates(limit), transaction: (work, lease) =>
    store.transaction(tx => work(new Proxy(tx, { get(target, key: keyof DisbursementTransaction) {
      if (key === 'finish') return async (...args: Parameters<DisbursementTransaction['finish']>) => { await target.finish(...args); throw Error('synthetic commit interruption'); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } })), lease) };
  assert.equal((await create(failAfterFinish).recoverPayment(first.payment.paymentId)).status, 'unavailable');
  assert.equal((await db.query('SELECT status FROM policy.payments WHERE id=$1', [first.payment.paymentId])).rows[0].status, 'pending');
  assert.equal((await db.query('SELECT status FROM policy.claims WHERE id=$1', [claimId])).rows[0].status, 'approved');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.claim_notices WHERE event_id=$1', [first.payment.paymentId])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE action='claims.disbursement.confirmed' AND resource_id=$1", [first.payment.paymentId])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.outbox_events WHERE event_type='claim.disbursement.confirmed'")).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id=$1', [first.payment.paymentId])).rows[0].n, 1);
  assert.equal((await service.reconcile())[0].status, 'confirmed');
  assert.equal((await service.read(claimId, actor()))?.status, 'confirmed');
  assert.equal((await db.query('SELECT status FROM policy.claims WHERE id=$1', [claimId])).rows[0].status, 'paid');
  await Promise.all([service.recoverPayment(first.payment.paymentId), service.recoverPayment(first.payment.paymentId)]);
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id=$1', [first.payment.paymentId])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.claim_notices WHERE event_id=$1', [first.payment.paymentId])).rows[0].n, 2);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE action='claims.disbursement.confirmed' AND resource_id=$1", [first.payment.paymentId])).rows[0].n, 1);

  const captures = (await db.query("SELECT payload FROM policy.outbox_events WHERE event_type LIKE 'claim.disbursement.%'")).rows;
  const validate = new Ajv().compile(JSON.parse(await readFile(new URL('../packages/contracts/schemas/decision-capture.v1.json', import.meta.url), 'utf8')));
  assert.ok(captures.length >= 2); for (const { payload } of captures) {
    assert.ok(validate(payload), JSON.stringify(validate.errors));
    assert.equal(typeof payload.inputs.reservedAmount, 'string');
    assert.equal(payload.inputs.policyTermsHash, await integrity.digest(offerContent(offer)));
  }
  const claim2 = await seed(), claim3 = await seed();
  const capRace = await Promise.all([service.request(claim2, { amount: '60000.0000' }, actor()), service.request(claim3, { amount: '60000.0000' }, actor())]);
  assert.equal(capRace.filter(result => result.status === 'ok').length, 1);
  assert.equal(capRace.filter(result => result.status === 'invalid_amount').length, 1);
  const raceClaim = await seed();
  const raceIntent = await service.request(raceClaim, { amount: '1.0000' }, actor());
  assert.equal(raceIntent.status, 'ok'); if (raceIntent.status !== 'ok') throw Error('race_intent_missing');
  const raceResults = await Promise.all([service.recoverPayment(raceIntent.payment.paymentId), service.recoverPayment(raceIntent.payment.paymentId)]);
  assert.ok(raceResults.every(result => result.status === 'confirmed' || result.status === 'unchanged'));
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id=$1', [raceIntent.payment.paymentId])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.claim_notices WHERE event_id=$1', [raceIntent.payment.paymentId])).rows[0].n, 2);
  // A delayed SQL authorization response cannot release protected data after lease expiry.
  const lease = { ...actor(), expiresAt: new Date(Date.now() + 1500).toISOString() };
  const delayed: DisbursementStore = { candidates: limit => store.candidates(limit), transaction: async (work, actor) => {
    const value = await store.transaction(work, actor);
    if (actor) await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(actor.expiresAt) - Date.now() + 20)));
    return value;
  } };
  await assert.rejects(create(delayed).read(claimId, lease), /authorization_expired/);
  const owner = { clientId: customer, subjectToken: subject };
  const receipts = await service.owned(owner, randomUUID());
  assert.equal(receipts.items.find(item => item.claimId === claimId)?.payment.status, 'confirmed');
  const selected = await service.owned(owner, randomUUID(), undefined, claimId);
  assert.deepEqual(selected, { items: receipts.items.filter(item => item.claimId === claimId), next: null });
  assert.deepEqual(await service.owned({ ...owner, clientId: randomUUID() }, randomUUID(), undefined, claimId), { items: [], next: null });
  assert.deepEqual(await service.owned({ ...owner, subjectToken: randomUUID() }, randomUUID(), undefined, claimId), { items: [], next: null });
  const review = new ClaimReview<ReadableStream<Uint8Array>>(new SqlClaimReview(connection), undefined, () => []);
  const access = (channel: 'web' | 'mobile', operation: string) => ({ allowed: true,
    actor: { kind: 'user', channel, operations: [operation], principal: owner } });
  const unexpected = async (): Promise<never> => { throw Error('unexpected_tracking_operation'); };
  const http = createHttp({
    finance: {} as never, authorizeFinancialAccess: unexpected, denyResourceAccess: unexpected,
    claims: { inbox: { list: unexpected }, review, disbursements: service,
      authorize: async input => input.cookie === 'synthetic-session' ? access('web', input.operation) : null },
    claimReport: { review, disbursements: service, report: { create: unexpected, receive: unexpected, submit: unexpected },
      authorize: async input => input.token === 'synthetic.jwt.token' ? access('mobile', input.operation) : null },
  });
  const bindings = { APP_ENV: 'local' } as PolicyEnv;
  const web = { cookie: 'solventa-session=synthetic-session' };
  const native = { authorization: 'Bearer synthetic.jwt.token' };
  const read = async (path: string, headers: HeadersInit) => {
    const reply = await http.request('/api/v1/claims' + path, { headers }, bindings);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    return await reply.json();
  };
  const webCase = await read('/' + claimId + '/customer', web);
  const nativeCase = await read('/native/cases/' + claimId, native);
  assert.deepEqual({ ...nativeCase, traceId: null }, { ...webCase, traceId: null });
  assert.equal(webCase.state, 'paid');
  assert.equal(webCase.history[0].action, 'disbursement_confirmed');
  assert.equal(webCase.history.at(-1).action, 'submitted');
  const [webReceipt, nativeReceipt] = await Promise.all([
    read('/customer/disbursements?claimId=' + claimId, web),
    read('/native/disbursements?claimId=' + claimId, native),
  ]);
  assert.deepEqual(webReceipt.items, selected.items);
  assert.deepEqual(nativeReceipt.items, selected.items);
  assert.equal((await http.request('/api/v1/claims/native/cases/' + claimId, { headers: web }, bindings)).status, 401);
  assert.equal((await http.request('/api/v1/claims/native/cases/' + randomUUID(), { headers: native }, bindings)).status, 404);
  assert.equal((await http.request('/api/v1/claims/native/disbursements?claimId=' + claimId + '&cursor=' + claimId, { headers: native }, bindings)).status, 400);
  assert.deepEqual(await service.owned({ ...owner, clientId: randomUUID() }, randomUUID()), { items: [], next: null });
  assert.deepEqual(await service.owned({ ...owner, subjectToken: randomUUID() }, randomUUID()), { items: [], next: null });
  assert.deepEqual(await service.owned(owner, randomUUID(), randomUUID()), { items: [], next: null });
  const effectsBeforeReads = (await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations')).rows[0].n;
  for (let i = 0; i < 8; i++) assert.equal((await service.request(await seed(), { amount: '0.0001' }, actor())).status, 'ok');
  const seen = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await service.owned(owner, randomUUID(), cursor);
    assert.ok(page.items.length <= 6);
    for (const item of page.items) { assert.ok(!seen.has(item.claimId)); seen.add(item.claimId); assert.ok(Number.isFinite(Date.parse(item.updatedAt))); }
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 11);
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations')).rows[0].n, effectsBeforeReads);
  const changedCurrency = await service.request(await seed(), { amount: '2.0000' }, actor());
  assert.equal(changedCurrency.status, 'ok'); if (changedCurrency.status !== 'ok') throw Error('tamper_intent_missing');
  await db.query("UPDATE policy.indemnities SET currency='USD' WHERE id=(SELECT indemnity_id FROM policy.payments WHERE id=$1)", [changedCurrency.payment.paymentId]);
  assert.equal((await service.recoverPayment(changedCurrency.payment.paymentId)).status, 'unavailable');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id=$1', [changedCurrency.payment.paymentId])).rows[0].n, 0);
  for (const action of ['cancelled', 'modified', 'renewed'] as const) {
    const endedPolicyId = randomUUID();
    await seedPolicy(endedPolicyId, { ...offer, acceptanceId: randomUUID(), offerId: randomUUID() });
    const earlier = await seed('approved', endedPolicyId, '2026-10-31T23:59:59.999Z');
    const accepted = await service.request(earlier, { amount: '1.0000' }, actor());
    assert.equal(accepted.status, 'ok'); if (accepted.status !== 'ok') throw Error('lifecycle_intent_missing');
    assert.equal((await create(failAfterFinish).recoverPayment(accepted.payment.paymentId)).status, 'unavailable');
    const change: LifecycleChange = { policyId: endedPolicyId, changeId: randomUUID(), action, reason: 'customer_request',
      at: '2026-11-01T00:00:00.000Z', replacementPolicyId: action === 'cancelled' ? null : policyId,
      sourceDocumentHash: documentHash, replacementDocumentHash: action === 'cancelled' ? null : documentHash,
      refund: 'not_automated', ruleVersion: 'academic-policy-lifecycle-1', documentHash: '' };
    change.documentHash = await integrity.digest(lifecycleContent(change));
    // Each fixture keeps its own unique replacement link, as the real append-only schema requires.
    if (action !== 'cancelled') {
      const replacementId = randomUUID();
      await seedPolicy(replacementId, { ...offer, acceptanceId: randomUUID(), offerId: randomUUID() });
      change.replacementPolicyId = replacementId; change.documentHash = await integrity.digest(lifecycleContent(change));
    }
    await db.query(`INSERT INTO policy.policy_lifecycle_changes(policy_id,change_id,actor_id,command_key,request_hash,replacement_policy_id,payload,occurred_at)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7)`, [endedPolicyId, change.changeId, customer, change.documentHash, change.replacementPolicyId, JSON.stringify(change), change.at]);
    for (const occurredAt of [change.at, '2026-11-01T00:00:00.001Z']) {
      const outside = await seed('approved', endedPolicyId, occurredAt);
      assert.deepEqual(await service.request(outside, { amount: '1.0000' }, actor()), { status: 'conflict' });
      assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.indemnities WHERE claim_id=$1', [outside])).rows[0].n, 0);
    }
    const covered = await seed('approved', endedPolicyId, '2026-10-31T23:59:59.999Z');
    assert.equal((await service.request(covered, { amount: '1.0000' }, actor())).status, 'ok');
    const replay = await service.request(earlier, { amount: '1.0000' }, actor());
    assert.equal(replay.status === 'ok' && replay.replayed, true);
    assert.equal((await service.recoverPayment(accepted.payment.paymentId)).status, 'confirmed');
    assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.mock_gateway_operations WHERE payment_id=$1', [accepted.payment.paymentId])).rows[0].n, 1);
    const captured = (await db.query("SELECT payload FROM policy.outbox_events WHERE aggregate_id=$1 AND event_type='claim.disbursement.requested'", [covered])).rows[0].payload;
    assert.deepEqual(captured.inputs.policyLifecycle, change); assert.equal(captured.rule.version, '2');
    await db.query('UPDATE policy.policy_lifecycle_changes SET payload=$2 WHERE policy_id=$1', [endedPolicyId, JSON.stringify({ ...change, at: '2026-11-02T00:00:00.000Z' })]);
    await assert.rejects(service.read(covered, actor()), /integrity/);
  }
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['assigned-grant-and-owner-boundary', 'expired-lease',
    'intent-before-provider', 'replay-and-concurrent-replay', 'changed-amount-conflict', 'provider-confirmed-before-local-rollback',
    'atomic-payment-claim-audit-notices', 'recovery-without-duplicate', 'concurrent-settlement', 'capture-schema', 'concurrent-coverage-reservation', 'late-sql-response-denied',
    'owner-receipt-isolation', 'owned-pagination-without-financial-effects', 'indemnity-currency-integrity',
    'lifecycle-cutoff-three-actions-at-and-after', 'pre-lifecycle-occurrence-accepted', 'accepted-payment-recovery-after-lifecycle',
    'lifecycle-capture-and-row-binding'] }));
} finally {
  await db?.end().catch(() => {});
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}
