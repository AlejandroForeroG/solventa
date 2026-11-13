import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlClaimInbox } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-inbox';
import { ClaimInbox } from '../backend/policy-claims-payments/src/application/claim-inbox';
import { InvalidClaimRecord, priorityOf, type ClaimPriority } from '../backend/policy-claims-payments/src/domain/claims';
import { SqlClaimDecisions } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-decisions';
import { ClaimReview } from '../backend/policy-claims-payments/src/application/claim-review';
import { SqlClaimReview } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-review';
import { ClaimDecisions } from '../backend/policy-claims-payments/src/application/claim-decisions';
import Ajv from 'ajv';

// Real disposable SQL with the real Policy runtime grants and migrations; nothing remote is touched.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_claims_inbox_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_claims_inbox_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let migrated = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect();
  const held = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  const users = (await admin.query('SHOW USERS')).rows;
  if (!users.some(user => user.username === 'solventa_local_policy')) await admin.query(`CREATE USER solventa_local_policy WITH PASSWORD '${held.passwords.policy}'`);
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA policy');
  await db.query('CREATE TABLE policy.schema_migrations(version STRING PRIMARY KEY,checksum STRING NOT NULL,applied_at TIMESTAMPTZ DEFAULT now())');
  const owner = owners.find(candidate => candidate.schema === 'policy')!;
  await applyMigrations(db, owner);
  await applyMigrations(db, owner);
  migrated = true;
  const grants = JSON.parse(await readFile('backend/policy-claims-payments/runtime-grants.json', 'utf8')) as Record<string, string[]>;
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_policy`);
  await db.query('GRANT USAGE ON SCHEMA policy TO solventa_local_policy');
  for (const [table, privileges] of Object.entries(grants)) await db.query(`GRANT ${privileges.join(',')} ON policy.${table} TO solventa_local_policy`);
  const runtime = new URL(url); runtime.username = 'solventa_local_policy'; runtime.password = held.passwords.policy;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');

  const policyId = randomUUID();
  await db.query(`INSERT INTO policy.policies (id,subject_token,offer_id,offer_version,idempotency_key,request_hash,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id)
    VALUES ($1,$2,$3,1,'synthetic-policy',$4,100000,'COP','{}',now(),now()+interval '1 year',$5)`, [policyId, randomUUID(), randomUUID(), 'a'.repeat(64), randomUUID()]);
  let sequence = 0;
  const seed = async (claim: { status: string; days: number; hours?: number; amount: string | null; number?: string | null; required?: number; at?: string; assignee?: string }) => {
    const id = randomUUID();
    sequence++;
    const createdAt = claim.at ?? new Date(Date.now() - claim.days * 86_400_000 + (claim.hours ?? 0) * 3_600_000).toISOString();
    const number = claim.number === undefined ? `SIN-2026-${String(sequence).padStart(5, '0')}` : claim.number;
    await db!.query(`INSERT INTO policy.claims (id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id,created_at,claim_number,estimated_amount,evidence_required,assignee_id)
      VALUES ($1,$2,$3,$4,$5,now(),$6,$7::TIMESTAMPTZ,$8,$9,$10,$11)`,
    [id, policyId, 'key-' + id, 'b'.repeat(64), claim.status, randomUUID(), createdAt, number, claim.amount, claim.required ?? 0, claim.assignee ?? null]);
    return { id, number };
  };
  const evidence = async (claimId: string, state: 'uploaded' | 'verified') => db!.query<{ id: string }>(`INSERT INTO policy.evidence_metadata (claim_id,object_key,content_type,byte_size,checksum_sha256,state,retention_until,correlation_id,verified_at)
    VALUES ($1,$2,'application/pdf',100,$3,$4,now()+interval '1 year',$5,${state === 'verified' ? 'now()' : 'NULL'}) RETURNING id`, [claimId, 'synthetic/' + randomUUID(), 'c'.repeat(64), state, randomUUID()]);

  // The parametric flow keeps writing claims with its original column list; the new columns must not disturb it.
  const legacy = randomUUID();
  await db.query(`INSERT INTO policy.claims(id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id) VALUES($1,$2,'parametric-once',$3,'approved',now(),$4)`,
    [legacy, policyId, 'd'.repeat(64), randomUUID()]);
  await db.query(`UPDATE policy.claims SET status='paid',version=version+1,updated_at=now() WHERE id=$1`, [legacy]);
  await seed({ status: 'approved', days: 20, amount: '10.0000' });
  await seed({ status: 'rejected', days: 20, amount: '10.0000' });

  const high1 = await seed({ status: 'in_review', days: 9, amount: '148000000.0000', required: 5 });
  const high2 = await seed({ status: 'in_review', days: 6, amount: '96500000.0000' });
  const escalated = await seed({ status: 'escalated', days: 0, amount: '305000000.0000', assignee: randomUUID() });
  const medium1 = await seed({ status: 'in_review', days: 3, amount: '212400000.0000' });
  const medium2 = await seed({ status: 'in_review', days: 2, amount: '74900000.0000' });
  const low1 = await seed({ status: 'unassigned', days: 1, amount: '58200000.0000' });
  const low2 = await seed({ status: 'pending_information', days: 1, hours: 1, amount: '99000000.0000' });
  const tie = new Date().toISOString();
  const tieSmall = await seed({ status: 'unassigned', days: 0, amount: '5.0000', at: tie });
  const tieLarge = await seed({ status: 'unassigned', days: 0, amount: '50.0000', at: tie });
  const tieNone = await seed({ status: 'unassigned', days: 0, amount: null, at: tie });

  const clock = { now: () => new Date() };
  const store = new SqlClaimInbox(runtime.toString());
  const inbox = new ClaimInbox(store, clock);
  const reader = () => ({ clientId: randomUUID(), traceId: randomUUID(), expiresAt: new Date(Date.now() + 5000).toISOString() });
  const auditRows = async () => Number((await db!.query(`SELECT count(*)::INT4 AS n FROM policy.audit_events WHERE action='claims.inbox.read'`)).rows[0].n);

  const first = await inbox.list({}, reader());
  assert.equal(first.items.length, 10, 'only open claims are listed, including one not yet estimated');
  const expected = [high1, high2, escalated, medium1, medium2, low1, low2];
  assert.deepEqual(first.items.slice(0, 7).map(item => item.claimId), expected.map(item => item.id));
  const tail = first.items.slice(7).map(item => item.claimId);
  assert.ok(tail.includes(tieLarge.id) && tail.includes(tieSmall.id) && tail.indexOf(tieLarge.id) < tail.indexOf(tieSmall.id), 'same age orders by larger amount first');
  assert.ok(tail.includes(tieNone.id) && tail.indexOf(tieSmall.id) < tail.indexOf(tieNone.id), 'a claim without an estimate sorts after every estimated one');
  assert.equal(first.items.find(item => item.claimId === tieNone.id)?.estimatedAmount, null);
  const rank: Record<ClaimPriority, number> = { high: 1, medium: 2, low: 3 };
  assert.ok(first.items.every((item, index) => index === 0 || rank[first.items[index - 1].priority] <= rank[item.priority]), 'priority never increases down the list');
  for (const item of first.items) assert.equal(item.priority, priorityOf(item.state, item.ageDays), 'SQL ordering and domain priority agree');
  assert.deepEqual(first.items.map(item => item.priority).slice(0, 7), ['high', 'high', 'high', 'medium', 'medium', 'low', 'low']);
  assert.equal(first.items[0].overdue, true); assert.equal(first.items[2].overdue, false);
  assert.equal(first.items[0].estimatedAmount, '148000000.0000'); assert.equal(first.items[0].currency, 'COP');
  assert.ok(!first.items.some(item => item.claimId === legacy), 'the parametric claim is not an open case');

  const stateOnly = await inbox.list({ state: 'unassigned' }, reader());
  assert.deepEqual(new Set(stateOnly.items.map(item => item.state)), new Set(['unassigned']));
  assert.equal(stateOnly.items.length, 4);
  assert.equal((await inbox.list({ state: 'paid' }, reader())).items.length, 0);
  const overdue = await inbox.list({ overdue: true }, reader());
  assert.deepEqual(overdue.items.map(item => item.claimId), [high1.id, high2.id]);
  assert.deepEqual((await inbox.list({ query: high1.number }, reader())).items.map(item => item.claimId), [high1.id]);
  assert.equal((await inbox.list({ query: policyId }, reader())).items.length, 10);
  assert.equal((await inbox.list({ query: 'SIN-2026-99999' }, reader())).items.length, 0);
  assert.equal((await inbox.list({ before: randomUUID() }, reader())).items.length, 0);
  assert.equal(first.items.find(item => item.claimId === escalated.id)?.assigneeId !== null, true);
  assert.equal(first.items.find(item => item.claimId === low1.id)?.assigneeId, null);

  const evidenceClaim = await seed({ status: 'in_review', days: 4, amount: '1.0000', required: 3 });
  const reviewClaim = await seed({ status: 'in_review', days: 4, hours: 1, amount: '1.0000', required: 2 });
  const doneClaim = await seed({ status: 'in_review', days: 4, hours: 2, amount: '1.0000', required: 1 });
  await evidence(evidenceClaim.id, 'verified'); await evidence(evidenceClaim.id, 'uploaded');
  await evidence(reviewClaim.id, 'verified'); await evidence(reviewClaim.id, 'uploaded');
  await evidence(doneClaim.id, 'verified'); await evidence(doneClaim.id, 'verified');
  const withEvidence = new Map((await inbox.list({ state: 'in_review' }, reader())).items.map(item => [item.claimId, item.evidence]));
  assert.deepEqual(withEvidence.get(evidenceClaim.id), { provided: 2, required: 3, status: 'incomplete' });
  assert.deepEqual(withEvidence.get(reviewClaim.id), { provided: 2, required: 2, status: 'in_review' });
  assert.deepEqual(withEvidence.get(doneClaim.id), { provided: 2, required: 1, status: 'complete' });

  for (let index = 0; index < 12; index++) await seed({ status: 'in_review', days: 2, hours: 3 + index, amount: '7.0000' });
  const page1 = await inbox.list({}, reader()); assert.equal(page1.items.length, 20); assert.ok(page1.next);
  const page2 = await inbox.list({ before: page1.next }, reader());
  const page3 = page2.next ? await inbox.list({ before: page2.next }, reader()) : { items: [], next: null };
  const everyone = [...page1.items, ...page2.items, ...page3.items];
  assert.equal(new Set(everyone.map(item => item.claimId)).size, everyone.length, 'no claim repeats across pages');
  assert.equal(everyone.length, 10 + 3 + 12, 'every open claim appears exactly once');
  assert.equal(page3.next, null);

  const before = await auditRows();
  await inbox.list({}, reader());
  assert.equal(await auditRows(), before + 1, 'each successful read is audited');
  await assert.rejects(store.list({}, { clientId: randomUUID(), traceId: randomUUID(), expiresAt: new Date(Date.now() - 1000).toISOString() }, { highDays: 5, mediumDays: 2, overdueDays: 5 }), /claims_authorization_expired/);
  assert.equal(await auditRows(), before + 1, 'an expired lease releases no data and records nothing');
  await db.query('REVOKE INSERT ON policy.audit_events FROM solventa_local_policy');
  try { await assert.rejects(inbox.list({}, reader()), /permission|privilege/i); }
  finally { await db.query('GRANT INSERT ON policy.audit_events TO solventa_local_policy'); }
  assert.equal(await auditRows(), before + 1, 'a failed audit write releases no data');

  const runtimeClient = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await runtimeClient.connect();
    await assert.rejects(runtimeClient.query('DELETE FROM policy.claims WHERE id=$1', [high1.id]), error => error.code === '42501');
  } finally { await runtimeClient.end(); }
  await assert.rejects(seed({ status: 'in_review', days: 1, amount: '1.0000', number: 'BAD-1' }), /claim_number/);
  await assert.rejects(seed({ status: 'in_review', days: 1, amount: '1.0000', number: high1.number }), /claims_claim_number_key|duplicate/i);
  await assert.rejects(seed({ status: 'in_review', days: 1, amount: '-1.0000' }), /estimated_amount/);

  const analyst = randomUUID();
  const decisionClaim = await seed({ status: 'in_review', days: 0, amount: '100.0000', required: 1, assignee: analyst });
  const proof = (await evidence(decisionClaim.id, 'verified')).rows[0].id;
  const decisions = new ClaimDecisions(new SqlClaimDecisions(runtime.toString()), { now: () => new Date() });
  const decisionActor = (clientId = analyst) => ({ clientId, traceId: randomUUID(), expiresAt: new Date(Date.now() + 5000).toISOString() });
  const decisionInput = { action: 'approve' as const, reason: 'Verified the synthetic supporting document.', evidenceIds: [proof] };
  const approved = await decisions.decide(decisionClaim.id, decisionInput, decisionActor(), 'synthetic-decision-key');
  assert.equal(approved.status, 'ok');
  assert.equal((await db.query('SELECT status FROM policy.claims WHERE id=$1', [decisionClaim.id])).rows[0].status, 'approved');
  const capture = (await db.query('SELECT decision_capture FROM policy.claim_decisions WHERE claim_id=$1', [decisionClaim.id])).rows[0].decision_capture;
  const validCapture = new Ajv({ strict: false }).compile(JSON.parse(await readFile('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
  assert.equal(validCapture(capture), true, JSON.stringify(validCapture.errors));
  assert.equal(capture.inputs.evidence[0].id, proof);
  assert.match(capture.inputs.reasonSha256, /^[0-9a-f]{64}$/);
  assert.equal(capture.inputs.reason, undefined);
  assert.equal(capture.rule.version, '1');
  const replay = await decisions.decide(decisionClaim.id, decisionInput, decisionActor(), 'synthetic-decision-key');
  assert.equal(replay.status, 'ok');
  if (replay.status === 'ok' && approved.status === 'ok') { assert.equal(replay.decisionId, approved.decisionId); assert.equal(replay.replayed, true); }
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.claim_decisions WHERE claim_id=$1', [decisionClaim.id])).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.outbox_events WHERE aggregate_id=$1 AND event_type='claim.decided'", [decisionClaim.id])).rows[0].n, 1);
  assert.deepEqual(await decisions.decide(decisionClaim.id, { ...decisionInput, reason: 'A changed supporting reason.' }, decisionActor(), 'synthetic-decision-key'), { status: 'conflict' });
  const foreignClaim = await seed({ status: 'in_review', days: 0, amount: '101.0000', required: 1, assignee: analyst });
  const foreignProof = (await evidence(foreignClaim.id, 'verified')).rows[0].id;
  assert.deepEqual(await decisions.decide(foreignClaim.id, { ...decisionInput, evidenceIds: [foreignProof] }, decisionActor(randomUUID()), 'foreign-key'), { status: 'not_found' });
  assert.equal((await db.query('SELECT status FROM policy.claims WHERE id=$1', [foreignClaim.id])).rows[0].status, 'in_review');
  const rollbackClaim = await seed({ status: 'in_review', days: 0, amount: '102.0000', required: 1, assignee: analyst });
  const rollbackProof = (await evidence(rollbackClaim.id, 'verified')).rows[0].id;
  await db.query('REVOKE INSERT ON policy.outbox_events FROM solventa_local_policy');
  try { await assert.rejects(decisions.decide(rollbackClaim.id, { ...decisionInput, evidenceIds: [rollbackProof] }, decisionActor(), 'rollback-key'), /permission|privilege/i); }
  finally { await db.query('GRANT INSERT ON policy.outbox_events TO solventa_local_policy'); }
  assert.equal((await db.query('SELECT status FROM policy.claims WHERE id=$1', [rollbackClaim.id])).rows[0].status, 'in_review');
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.claim_decisions WHERE claim_id=$1', [rollbackClaim.id])).rows[0].n, 0);
  const racingClaim = await seed({ status: 'in_review', days: 0, amount: '103.0000', required: 1, assignee: analyst });
  const racingProof = (await evidence(racingClaim.id, 'verified')).rows[0].id;
  const racingInput = { ...decisionInput, evidenceIds: [racingProof] };
  const racing = await Promise.all([decisions.decide(racingClaim.id, racingInput, decisionActor(), 'shared-race-key'),
    decisions.decide(racingClaim.id, racingInput, decisionActor(), 'shared-race-key')]);
  assert.ok(racing.every(result => result.status === 'ok'));
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.claim_decisions WHERE claim_id=$1', [racingClaim.id])).rows[0].n, 1);

  await seed({ status: 'in_review', days: 1, amount: null, number: null });
  await assert.rejects(inbox.list({ state: 'in_review' }, reader()), InvalidClaimRecord);
  const ownerSubject = randomUUID();
  await db.query("UPDATE policy.policies SET subject_token=$2 WHERE id=$1", [policyId, ownerSubject]);
  const caseCustomer = { clientId: randomUUID(), subjectToken: ownerSubject };
  const caseReviewer = { clientId: randomUUID(), subjectToken: randomUUID() };
  const analystLease = () => ({ ...caseReviewer, traceId: randomUUID(), expiresAt: new Date(Date.now()+5000).toISOString() });
  const caseOwner = { kind: 'customer' as const, actor: caseCustomer };
  const caseAnalyst = () => ({ kind: 'analyst' as const, actor: analystLease() });
  const testClaim = await seed({ status: 'unassigned', days: 0, amount: null, required: 1 });
  await db.query("UPDATE policy.claims SET submitted_at=now(), event_type='other', description='Synthetic document report for local evaluation.' WHERE id=$1", [testClaim.id]);
  const original = (await evidence(testClaim.id, 'verified')).rows[0].id;
  const operations = new SqlClaimReview(runtime.toString());
  const sampleExpert = { id: 'demo-bog-expert', name: 'Synthetic expert' };
  const review = new ClaimReview(operations, undefined, () => [sampleExpert]);
  const id = testClaim.id;
  const listed = await review.owned(caseCustomer, randomUUID());
  assert.deepEqual(listed, [{ claimId: id, claimNumber: testClaim.number, state: 'unassigned' }]);
  assert.deepEqual(await review.owned({ clientId: randomUUID(), subjectToken: randomUUID() }, randomUUID()), []);
  const initial = await review.detail(id, caseAnalyst(), randomUUID());
  assert.equal(initial?.description, null);
  assert.deepEqual(initial?.evidence, []);
  const otherAnalyst = { ...analystLease(), clientId: randomUUID() };
  const ownAnalyst = { ...analystLease(), ...caseCustomer };
  assert.deepEqual(await review.review(id, ownAnalyst, { action: 'take' }, 'own-case'), { status: 'not_found' });
  assert.equal((await review.review(id, analystLease(), { action: 'take' }, 'take-case')).status, 'ok');
  assert.deepEqual(await review.review(id, otherAnalyst, { action: 'take' }, 'another-take'), { status: 'not_found' });
  assert.deepEqual(await review.detail(id, { kind: 'analyst', actor: otherAnalyst }, randomUUID()), null);
  assert.equal((await review.evidence(id, original, caseAnalyst(), randomUUID()))?.id, original);

  const requestMore = { action: 'request_information', details: 'Provide the incident location and a supporting receipt.',
    deadline: new Date(Date.now()+3600000).toISOString() };
  const required = await review.review(id, analystLease(), requestMore, 'request-info');
  assert.equal(required.status, 'ok');
  if (required.status !== 'ok') throw Error('requirement_not_created');
  const requirement = required.actionId;
  assert.equal(required.state, 'pending_information');
  assert.deepEqual(await review.review(id, analystLease(), { ...requestMore, details: 'A different requested document' }, 'request-info'), { status: 'conflict' });
  assert.deepEqual(await review.review(id, analystLease(), requestMore, 'request-info'), { ...required, replayed: true });
  assert.equal((await review.detail(id, caseOwner, randomUUID()))?.requirements[0].id, requirement);
  assert.equal((await review.detail(id, caseOwner, randomUUID()))?.notices.some(notice => notice.action === 'request_information'), true);
  const responseFile = { fileId: randomUUID(), byteSize: 100, contentType: 'image/jpeg' as const, sha256: 'b'.repeat(64) };
  const prepare = await operations.prepareFile(id, requirement, caseCustomer, responseFile, randomUUID());
  assert.equal(prepare.status, 'pending');
  assert.deepEqual(await operations.prepareFile(id, requirement, caseCustomer, { ...responseFile, byteSize: 101 }, randomUUID()), { status: 'conflict' });
  const extend = { action: 'extend_requirement', requirementId: requirement, reason: 'The owner needs additional time to respond.',
    deadline: new Date(Date.now()+7200000).toISOString() };
  assert.deepEqual(await review.review(id, analystLease(), extend, 'extend-deadline'), { status: 'conflict' });
  await db.query("UPDATE policy.claim_requirements SET deadline=now()-INTERVAL '1 minute' WHERE id=$1", [requirement]);
  assert.deepEqual(await review.respond(id, requirement, caseCustomer, { text: 'Late response', evidenceIds: [] }, 'late-response', randomUUID()), { status: 'conflict' });
  assert.deepEqual(await review.review(id, otherAnalyst, extend, 'extend-deadline'), { status: 'not_found' });
  const extended = await review.review(id, analystLease(), extend, 'extend-deadline');
  assert.equal(extended.status, 'ok');
  assert.deepEqual(await review.review(id, analystLease(), extend, 'extend-deadline'), { ...extended, replayed: true });
  const reopened = await review.detail(id, caseOwner, randomUUID());
  assert.equal(reopened?.requirements[0].deadline, extend.deadline);
  assert.equal(reopened?.notices.filter(notice => notice.action === 'extend_requirement').length, 1);
  const response = { text: 'Synthetic information attached.', evidenceIds: [responseFile.fileId] };
  assert.deepEqual(await review.respond(id, requirement, { clientId: randomUUID(), subjectToken: randomUUID() }, response, 'response-external', randomUUID()), { status: 'not_found' });
  assert.deepEqual(await review.respond(id, requirement, caseCustomer, response, 'response-once', randomUUID()), { status: 'invalid_evidence' });
  assert.equal(await operations.verifyFile(id, requirement, caseCustomer, responseFile.fileId, randomUUID()), true);
  assert.equal((await operations.prepareFile(id, requirement, caseCustomer, responseFile, randomUUID())).status, 'verified');
  assert.equal((await review.detail(id, caseAnalyst(), randomUUID()))?.evidence.length, 1, 'the file is hidden before submission');
  const received = await review.respond(id, requirement, caseCustomer, response, 'response-once', randomUUID());
  assert.equal(received.status, 'ok');
  assert.deepEqual(await review.respond(id, requirement, caseCustomer, response, 'response-once', randomUUID()), { ...received, replayed: true });
  const afterResponse = await review.detail(id, caseAnalyst(), randomUUID());
  assert.equal(afterResponse?.state, 'in_review');
  assert.equal(afterResponse.requirements[0].status, 'received');
  assert.equal(afterResponse.requirements[0].responseText, response.text);
  assert.equal(afterResponse.requirements[0].evidenceIds.length, 1);
  assert.equal(afterResponse.evidence.length, 2);
  assert.equal(afterResponse.notices.filter(notice => notice.action === 'respond').length, 1);

  const assign = await review.review(id, analystLease(), { action: 'assign_expert', expertId: sampleExpert.id, reason: 'Synthetic case needs an expert.' }, 'assign-expert');
  assert.equal(assign.status, 'ok');
  const escalatedCase = await review.detail(id, caseAnalyst(), randomUUID());
  assert.equal(escalatedCase?.state, 'escalated');
  assert.deepEqual(escalatedCase.history[0].expert, sampleExpert);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM policy.claim_notices WHERE claim_id=$1 AND audience='expert'", [id])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::INT4 AS n FROM policy.indemnities WHERE claim_id=$1', [id])).rows[0].n, 0);
  const verdict = await decisions.decide(id, { action: 'reject', reason: 'Synthetic decision after evaluation.', evidenceIds: [original] }, analystLease(), 'final-decision');
  assert.equal(verdict.status, 'ok');
  assert.equal((await review.detail(id, caseOwner, randomUUID()))?.state, 'rejected');
  assert.equal((await review.detail(id, caseOwner, randomUUID()))?.notices.filter(notice => notice.action === 'reject').length, 1);
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['legacy-parametric-insert', 'open-only', 'priority-order', 'amount-tiebreak', 'filters', 'evidence-summary',
    'stable-pagination', 'read-audit', 'expired-lease', 'audit-failure-blocks-data', 'runtime-no-delete', 'constraints', 'decision-commit', 'decision-replay', 'decision-key-conflict', 'assignment-denial', 'decision-rollback', 'concurrent-decision-replay', 'unestimated-claim-last', 'fail-closed-on-incomplete-open-claim', 'assigned-case-detail', 'requirement-and-response', 'expert-segregation', 'participant-notices', 'expired-requirement-extension', 'verified-upload-resume'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
