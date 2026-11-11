import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlClaimReport } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-report';
import { SqlClaimInbox } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-inbox';
import { ClaimInbox } from '../backend/policy-claims-payments/src/application/claim-inbox';
import type { ReportInput } from '../backend/policy-claims-payments/src/domain/claim-report';

// Real disposable SQL with the real Policy runtime grants and migrations; nothing remote is touched.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_claim_report_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_claim_report_test_[a-f0-9]{32}$/);
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

  const ownerA = { clientId: randomUUID(), subjectToken: randomUUID() };
  const ownerB = { clientId: randomUUID(), subjectToken: randomUUID() };
  const policyId = randomUUID();
  await db.query(`INSERT INTO policy.policies (id,subject_token,offer_id,offer_version,idempotency_key,request_hash,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id,status)
    VALUES ($1,$2,$3,1,'synthetic-policy',$4,100000,'COP','{}',now()-interval '1 day',now()+interval '1 year',$5,'issued')`, [policyId, ownerA.subjectToken, randomUUID(), 'a'.repeat(64), randomUUID()]);
  const pendingPolicyId = randomUUID();
  await db.query(`INSERT INTO policy.policies (id,subject_token,offer_id,offer_version,idempotency_key,request_hash,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id)
    VALUES ($1,$2,$3,1,'synthetic-pending-policy',$4,100000,'COP','{}',now()-interval '1 day',now()+interval '1 year',$5)`, [pendingPolicyId, ownerA.subjectToken, randomUUID(), 'b'.repeat(64), randomUUID()]);
  const store = new SqlClaimReport(runtime.toString());
  const inbox = new ClaimInbox(new SqlClaimInbox(runtime.toString()), { now: () => new Date() });
  const reader = () => ({ clientId: randomUUID(), traceId: randomUUID(), expiresAt: new Date(Date.now() + 5000).toISOString() });
  const hash = (seed: string) => seed.padEnd(64, '0').slice(0, 64);
  const input = (change: Partial<ReportInput> = {}): ReportInput => ({ policyId, eventType: 'collision', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), place: 'Autopista Norte con Calle 116',
    description: 'Colisión por alcance en la Autopista Norte con Calle 116, sentido sur. El otro vehículo frenó de golpe.',
    evidence: [{ fileId: randomUUID(), contentType: 'image/jpeg', byteSize: 2048, sha256: 'c'.repeat(64) }, { fileId: randomUUID(), contentType: 'video/mp4', byteSize: 4096, sha256: 'd'.repeat(64) }], ...change });
  const draft = async (report = input(), key = 'key-' + randomUUID(), who = ownerA) => {
    const outcome = await store.createDraft({ owner: who, report, idempotencyKey: key, requestHash: hash(key), traceId: randomUUID() });
    assert.ok(outcome.status === 'created', outcome.status);
    return { report, key, claimId: outcome.claim.claimId };
  };
  const receiveAll = async (claimId: string, report: ReportInput) => {
    for (const item of report.evidence) assert.equal(await store.markVerified(ownerA, claimId, item.fileId, randomUUID()), true);
  };

  const first = input();
  const key = 'retry-' + randomUUID();
  const outcome = await store.createDraft({ owner: ownerA, report: first, idempotencyKey: key, requestHash: hash('one'), traceId: randomUUID() });
  assert.equal(outcome.status, 'created');
  const claimId = (outcome as { claim: { claimId: string } }).claim.claimId;
  assert.deepEqual((outcome as { claim: { state: string; evidence: unknown[] } }).claim.state, 'draft');
  const replay = await store.createDraft({ owner: ownerA, report: first, idempotencyKey: key, requestHash: hash('one'), traceId: randomUUID() });
  assert.equal(replay.status, 'replayed'); assert.equal((replay as { claim: { claimId: string } }).claim.claimId, claimId);
  assert.equal((await store.createDraft({ owner: ownerA, report: first, idempotencyKey: key, requestHash: hash('two'), traceId: randomUUID() })).status, 'idempotency_conflict');
  assert.equal((await store.createDraft({ owner: ownerB, report: first, idempotencyKey: 'other-' + randomUUID(), requestHash: hash('x'), traceId: randomUUID() })).status, 'policy_not_found');
  assert.equal((await store.createDraft({ owner: ownerA, report: input({ policyId: pendingPolicyId }), idempotencyKey: 'pending-' + randomUUID(), requestHash: hash('p'), traceId: randomUUID() })).status, 'policy_not_found', 'a policy that is not issued yet has no coverage to report against');
  assert.equal((await store.createDraft({ owner: ownerA, report: input({ occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }), idempotencyKey: 'early-' + randomUUID(), requestHash: hash('y'), traceId: randomUUID() })).status, 'outside_coverage');
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM policy.claims WHERE status='draft'`)).rows[0].n), 1, 'retries, strangers and out-of-coverage dates create nothing');

  const row = (await db.query('SELECT status, claim_number, estimated_amount, evidence_required, submitted_at, event_type FROM policy.claims WHERE id=$1', [claimId])).rows[0];
  assert.deepEqual([row.status, row.claim_number, row.estimated_amount, row.evidence_required, row.submitted_at, row.event_type], ['draft', null, null, 0, null, 'collision']);
  const files = (await db.query('SELECT object_key, state, retention_until > now() + interval \'300 days\' AS kept FROM policy.evidence_metadata WHERE claim_id=$1', [claimId])).rows;
  assert.equal(files.length, 2); assert.ok(files.every(file => file.state === 'pending' && file.kept && file.object_key.startsWith(`claims/${claimId}/`)));
  assert.equal((await inbox.list({}, reader())).items.length, 0, 'a draft is not an open claim');

  assert.equal(await store.evidence(ownerB, claimId, first.evidence[0].fileId), null);
  assert.deepEqual(await store.evidence(ownerA, claimId, first.evidence[0].fileId), { claimState: 'draft', contentType: 'image/jpeg', byteSize: 2048, sha256: 'c'.repeat(64), state: 'pending' });
  assert.equal(await store.markVerified(ownerB, claimId, first.evidence[0].fileId, randomUUID()), false);
  assert.deepEqual(await store.submit(ownerB, claimId, randomUUID()), { status: 'not_found' });
  assert.deepEqual(await store.submit(ownerA, claimId, randomUUID()), { status: 'incomplete', missing: first.evidence.map(file => file.fileId).sort() });
  assert.equal(await store.markVerified(ownerA, claimId, first.evidence[0].fileId, randomUUID()), true);
  assert.equal(await store.markVerified(ownerA, claimId, first.evidence[0].fileId, randomUUID()), true, 'a repeated verification is still a received file');
  assert.deepEqual(await store.submit(ownerA, claimId, randomUUID()), { status: 'incomplete', missing: [first.evidence[1].fileId] });
  await store.markVerified(ownerA, claimId, first.evidence[1].fileId, randomUUID());

  const year = Number((await db.query(`SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Bogota'))::INT4 AS y`)).rows[0].y);
  const submitted = await store.submit(ownerA, claimId, randomUUID());
  assert.equal(submitted.status, 'submitted');
  assert.equal((submitted as { claimNumber: string }).claimNumber, `SIN-${year}-00001`);
  const again = await store.submit(ownerA, claimId, randomUUID());
  assert.deepEqual(again, { ...submitted, status: 'already_submitted' });
  const listed = (await inbox.list({}, reader())).items;
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].claimId, listed[0].state, listed[0].estimatedAmount, listed[0].priority, listed[0].evidence], [claimId, 'unassigned', null, 'low', { provided: 2, required: 1, status: 'complete' }]);
  assert.deepEqual((await inbox.list({ query: `SIN-${year}-00001` }, reader())).items.map(item => item.claimId), [claimId]);
  assert.equal(await store.markVerified(ownerA, claimId, first.evidence[0].fileId, randomUUID()), true);
  assert.equal((await store.evidence(ownerA, claimId, first.evidence[0].fileId))?.claimState, 'unassigned');

  const racing = input(); const racingKey = 'race-' + randomUUID();
  const both = await Promise.all([1, 2].map(() => store.createDraft({ owner: ownerA, report: racing, idempotencyKey: racingKey, requestHash: hash('race'), traceId: randomUUID() })));
  assert.deepEqual(both.map(result => result.status).sort(), ['created', 'replayed'], 'two simultaneous identical requests make one draft');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM policy.claims WHERE idempotency_key=$1', [racingKey])).rows[0].n), 1);

  const batch = [];
  for (let index = 0; index < 5; index++) { const item = await draft(); await receiveAll(item.claimId, item.report); batch.push(item); }
  const results = await Promise.all(batch.map(item => store.submit(ownerA, item.claimId, randomUUID())));
  assert.ok(results.every(result => result.status === 'submitted'), JSON.stringify(results));
  const numbers = results.map(result => (result as { claimNumber: string }).claimNumber).sort();
  assert.deepEqual(numbers, [2, 3, 4, 5, 6].map(sequence => `SIN-${year}-${String(sequence).padStart(5, '0')}`), 'simultaneous submissions get distinct consecutive numbers');
  assert.equal(Number((await db.query('SELECT count(DISTINCT claim_number) AS n FROM policy.claims WHERE claim_number IS NOT NULL')).rows[0].n), 6);

  const blocked = await draft(); await receiveAll(blocked.claimId, blocked.report);
  const counterBefore = (await db.query('SELECT last_number FROM policy.claim_number_counters WHERE year=$1', [year])).rows[0].last_number;
  await db.query('REVOKE INSERT ON policy.audit_events FROM solventa_local_policy');
  try { await assert.rejects(store.submit(ownerA, blocked.claimId, randomUUID()), /permission|privilege/i); }
  finally { await db.query('GRANT INSERT ON policy.audit_events TO solventa_local_policy'); }
  assert.equal((await db.query('SELECT status, claim_number FROM policy.claims WHERE id=$1', [blocked.claimId])).rows[0].status, 'draft', 'a failed audit write leaves the draft untouched');
  assert.equal((await db.query('SELECT last_number FROM policy.claim_number_counters WHERE year=$1', [year])).rows[0].last_number, counterBefore, 'and releases no number');
  assert.equal((await store.submit(ownerA, blocked.claimId, randomUUID())).status, 'submitted');

  const actions = new Map((await db.query('SELECT action, count(*)::INT4 AS n FROM policy.audit_events GROUP BY action')).rows.map(entry => [entry.action, entry.n]));
  assert.ok((actions.get('claims.report.draft') ?? 0) >= 8 && (actions.get('claims.report.evidence') ?? 0) >= 12 && actions.get('claims.report.submit') === 7, JSON.stringify([...actions]));

  const runtimeClient = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await runtimeClient.connect();
    for (const statement of ['DELETE FROM policy.claims', 'DELETE FROM policy.evidence_metadata', 'DELETE FROM policy.claim_number_counters', 'UPDATE policy.audit_events SET outcome=\'x\'']) {
      await assert.rejects(runtimeClient.query(statement), error => error.code === '42501', statement);
    }
  } finally { await runtimeClient.end(); }
  await assert.rejects(db.query(`UPDATE policy.claims SET description='short' WHERE id=$1`, [claimId]), /description/);
  await assert.rejects(db.query(`UPDATE policy.claims SET event_type='fire' WHERE id=$1`, [claimId]), /event_type/);
  await assert.rejects(db.query(`INSERT INTO policy.claim_number_counters(year,last_number) VALUES (2026,100000)`), /last_number/);
  await assert.rejects(db.query(`INSERT INTO policy.evidence_metadata (claim_id,object_key,content_type,byte_size,checksum_sha256,retention_until,correlation_id,client_file_id)
    VALUES ($1,$2,'image/jpeg',1,$3,now()+interval '1 day',$4,$5)`, [claimId, 'claims/other', 'e'.repeat(64), randomUUID(), first.evidence[0].fileId]), /evidence_by_client_file|duplicate/i);
  const legacy = randomUUID();
  await db.query(`INSERT INTO policy.claims(id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id) VALUES($1,$2,'parametric-once',$3,'approved',now(),$4)`, [legacy, policyId, 'f'.repeat(64), randomUUID()]);
  assert.ok(!(await inbox.list({}, reader())).items.some(item => item.claimId === legacy), 'the parametric flow keeps its claims and is not listed');
  // Adapter fixture only: the financial smoke separately creates and validates the actual sealed lifecycle command.
  const lifecycleAt = new Date(Date.now() - 1_800_000).toISOString();
  await db.query(`INSERT INTO policy.policy_lifecycle_changes(policy_id,change_id,actor_id,command_key,request_hash,payload,occurred_at)
    VALUES($1,$2,$3,$4,$5,'{}',$6)`, [policyId, randomUUID(), ownerA.clientId, 'a'.repeat(64), 'b'.repeat(64), lifecycleAt]);
  const claimCount = Number((await db.query('SELECT count(*) AS n FROM policy.claims')).rows[0].n);
  for (const occurredAt of [lifecycleAt, new Date(Date.parse(lifecycleAt) + 1).toISOString()]) {
    const key = 'ended-' + randomUUID();
    assert.equal((await store.createDraft({ owner: ownerA, report: input({ occurredAt }), idempotencyKey: key, requestHash: hash(key), traceId: randomUUID() })).status, 'outside_coverage');
  }
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM policy.claims')).rows[0].n), claimCount);
  const priorKey = 'prior-' + randomUUID();
  assert.equal((await store.createDraft({ owner: ownerA, report: input({ occurredAt: new Date(Date.parse(lifecycleAt) - 1).toISOString() }), idempotencyKey: priorKey, requestHash: hash(priorKey), traceId: randomUUID() })).status, 'created');
  assert.equal((await store.createDraft({ owner: ownerA, report: first, idempotencyKey: key, requestHash: hash('one'), traceId: randomUUID() })).status, 'replayed');
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['draft', 'idempotent-replay', 'payload-conflict', 'owner-isolation', 'issued-policy-only', 'coverage-window', 'lifecycle-termination-boundary', 'historical-draft-replay', 'draft-not-listed', 'evidence-verification',
    'incomplete-submit', 'single-number', 'inbox-shows-unestimated', 'concurrent-identical-requests', 'concurrent-numbering', 'audit-rollback', 'runtime-privileges', 'constraints', 'legacy-insert'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
