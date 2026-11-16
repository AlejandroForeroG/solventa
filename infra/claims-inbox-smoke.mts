import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlClaimInbox } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-inbox';
import { ClaimInbox } from '../backend/policy-claims-payments/src/application/claim-inbox';
import { InvalidClaimRecord, priorityOf, type ClaimPriority } from '../backend/policy-claims-payments/src/domain/claims';

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
  const evidence = async (claimId: string, state: 'uploaded' | 'verified') => db!.query(`INSERT INTO policy.evidence_metadata (claim_id,object_key,content_type,byte_size,checksum_sha256,state,retention_until,correlation_id,verified_at)
    VALUES ($1,$2,'application/pdf',100,$3,$4,now()+interval '1 year',$5,${state === 'verified' ? 'now()' : 'NULL'})`, [claimId, 'synthetic/' + randomUUID(), 'c'.repeat(64), state, randomUUID()]);

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

  await seed({ status: 'in_review', days: 1, amount: null, number: null });
  await assert.rejects(inbox.list({ state: 'in_review' }, reader()), InvalidClaimRecord);
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['legacy-parametric-insert', 'open-only', 'priority-order', 'amount-tiebreak', 'filters', 'evidence-summary',
    'stable-pagination', 'read-audit', 'expired-lease', 'audit-failure-blocks-data', 'runtime-no-delete', 'constraints', 'fail-closed-on-incomplete-open-claim', 'unestimated-claim-last'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
