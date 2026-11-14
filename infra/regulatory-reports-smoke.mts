import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlReportStore } from '../backend/policy-claims-payments/src/adapters/outbound/sql-report-store';
import { SqlMockReportDestination } from '../backend/policy-claims-payments/src/adapters/outbound/sql-mock-report-destination';
import { Reports } from '../backend/policy-claims-payments/src/application/reports';
import { TimerDeadline } from '../backend/policy-claims-payments/src/adapters/outbound/timer-deadline';
import { Sha256ReportDigest } from '../backend/policy-claims-payments/src/adapters/outbound/sha256-report-digest';
import { periodBounds, ReportError, type ReportDelivery, type ReportDestinationId } from '../backend/policy-claims-payments/src/domain/report';

// Real disposable SQL with the real Policy runtime grants and migrations; nothing remote is touched.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_reports_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_reports_test_[a-f0-9]{32}$/);
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

  // Facts around the October 2026 boundaries in Bogotá: 2026-10-31T23:30-05:00 is still October, 2026-11-01T00:30-05:00 is already November.
  const period = '2026-10';
  const policy = async (signedAt: string | null, status = 'issued', kind = 'mortgage_life') => {
    const id = randomUUID();
    await db!.query(`INSERT INTO policy.policies (id,subject_token,offer_id,offer_version,idempotency_key,request_hash,status,premium,currency,coverage_snapshot,effective_from,effective_until,correlation_id)
      VALUES ($1,$2,$3,1,$4,$5,$6,1250000.5,'COP',$7::JSONB,'2026-10-01T05:00:00Z','2027-10-01T05:00:00Z',$8)`,
    [id, randomUUID(), randomUUID(), 'key-' + id, 'a'.repeat(64), status, JSON.stringify(kind === 'mortgage_life' ? { kind, sumInsured: '148000000.0000' } : { kind, payoutAmount: '100000.0000' }), randomUUID()]);
    if (signedAt) await db!.query(`INSERT INTO policy.policy_signatures (policy_id,document_hash,provider,receipt,signed_at) VALUES ($1,$2,'synthetic-signature-v1',$3,$4)`, [id, 'b'.repeat(64), 'c'.repeat(64), signedAt]);
    return id;
  };
  const insidePolicy = await policy('2026-10-15T15:00:00Z');
  const lastMinute = await policy('2026-11-01T04:30:00Z', 'issued', 'flight_delay');
  await policy('2026-11-01T05:30:00Z');
  await policy('2026-10-10T15:00:00Z', 'charged');
  const cancelled = await policy('2026-09-20T15:00:00Z');
  await db.query(`INSERT INTO policy.policy_lifecycle_changes (policy_id,change_id,actor_id,command_key,request_hash,payload,occurred_at) VALUES ($1,$2,$3,$4,$5,'{"action":"cancelled"}'::JSONB,'2026-10-25T14:00:00Z')`,
    [cancelled, randomUUID(), randomUUID(), 'd'.repeat(64), 'e'.repeat(64)]);
  const claim = async (status: string, at: string, amount: string | null, number: string | null) => {
    const id = randomUUID();
    await db!.query(`INSERT INTO policy.claims (id,policy_id,idempotency_key,request_hash,status,occurred_at,correlation_id,created_at,submitted_at,claim_number,estimated_amount)
      VALUES ($1,$2,$3,$4,$5,now(),$6,$7::TIMESTAMPTZ,$7::TIMESTAMPTZ,$8,$9)`, [id, insidePolicy, 'key-' + id, 'f'.repeat(64), status, randomUUID(), at, number, amount]);
    return id;
  };
  await claim('draft', '2026-10-12T15:00:00Z', null, null);
  await claim('in_review', '2026-10-13T15:00:00Z', '15000000.0000', 'SIN-2026-00001');
  const paidClaim = await claim('paid', '2026-10-14T15:00:00Z', null, null);
  await claim('in_review', '2026-11-02T15:00:00Z', '9000000.0000', 'SIN-2026-00002');
  const payment = async (operation: 'premium' | 'indemnity', status: string, at: string, amount: string, indemnityId: string | null = null) => {
    const id = randomUUID();
    await db!.query(`INSERT INTO policy.payments (id,policy_id,indemnity_id,operation,idempotency_key,request_hash,amount,currency,provider,provider_reference,status,correlation_id,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'COP','mock',$8,$9,$10,$11)`, [id, insidePolicy, indemnityId, operation, 'key-' + id, '9'.repeat(64), amount, 'MOCK-' + id, status, randomUUID(), at]);
    return id;
  };
  const indemnityId = randomUUID();
  await db.query(`INSERT INTO policy.indemnities (id,claim_id,policy_id,amount,currency,status,correlation_id) VALUES ($1,$2,$3,100000,'COP','confirmed',$4)`, [indemnityId, paidClaim, insidePolicy, randomUUID()]);
  await payment('premium', 'confirmed', '2026-10-15T15:01:00Z', '1250000.5000');
  await payment('premium', 'pending', '2026-10-16T15:01:00Z', '999.0000');
  await payment('indemnity', 'confirmed', '2026-10-14T16:00:00Z', '100000.0000', indemnityId);

  const connection = runtime.toString();
  const store = new SqlReportStore(connection);
  const destinations = (fault: 'none' | 'timeout' = 'none'): Record<ReportDestinationId, SqlMockReportDestination> => ({ regulator: new SqlMockReportDestination('regulator', connection, fault), reinsurer: new SqlMockReportDestination('reinsurer', connection, fault) });
  const lease = () => ({ clientId: randomUUID(), traceId: randomUUID(), expiresAt: new Date(Date.now() + 5000).toISOString() });
  const reports = (fault: 'none' | 'timeout' = 'none') => new Reports(store, new Sha256ReportDigest(), destinations(fault), { now: () => new Date() }, new TimerDeadline(), 700);
  const count = async (sql: string, ...params: unknown[]) => Number((await db!.query(sql, params)).rows[0].n);

  const facts = await store.facts(periodBounds(period));
  assert.deepEqual(facts.policies.map(row => `${row.type}:${row.policyId}`).sort(), [`policy_cancelled:${cancelled}`, `policy_issued:${insidePolicy}`, `policy_issued:${lastMinute}`].sort(),
    'issued and ended policies of the Bogotá month, excluding the next month and a policy that is not issued');
  assert.equal(facts.policies.find(row => row.policyId === lastMinute)?.coverageAmount, '100000.0000');
  assert.deepEqual(facts.claims.map(row => row.state).sort(), ['in_review', 'paid'], 'a draft and a claim of another month are not reported');
  assert.equal(facts.claims.find(row => row.state === 'paid')?.claimNumber, null);
  assert.deepEqual(facts.payments.map(row => `${row.operation}:${row.state}`).sort(), ['indemnity:confirmed', 'premium:confirmed'], 'a pending payment is not confirmed');

  const operator = lease();
  const first = await reports().generate({ period, destination: 'reinsurer' }, operator);
  assert.equal(first.created, true); assert.equal(first.report.manifest.revision, 1);
  const again = await reports().generate({ period, destination: 'reinsurer' }, lease());
  assert.equal(again.created, false); assert.equal(again.report.id, first.report.id);
  const parallel = await Promise.all([reports().generate({ period, destination: 'regulator' }, lease()), reports().generate({ period, destination: 'regulator' }, lease())]);
  assert.equal(parallel[0].report.id, parallel[1].report.id, 'two concurrent generations of the same content give one revision');
  assert.equal(await count('SELECT count(*) AS n FROM policy.report_revisions WHERE destination=$1', 'regulator'), 1);
  const empty = await reports().generate({ period: '2026-01', destination: 'regulator' }, lease());
  assert.equal(empty.report.manifest.rowCount, 0);
  const stored = await store.load(first.report.id);
  assert.equal((await reports().download(first.report.id, 'csv', lease())).status, 'ok');
  assert.equal(stored?.content.split('\n')[0].startsWith('record_type,policy_id,claim_id'), true);

  await db.query(`UPDATE policy.payments SET amount=1250000.5001 WHERE operation='premium' AND status='confirmed'`);
  const changed = await reports().generate({ period, destination: 'reinsurer' }, lease());
  assert.equal(changed.created, true); assert.equal(changed.report.manifest.revision, 2); assert.notEqual(changed.report.contentHash, first.report.contentHash);
  assert.equal((await store.load(first.report.id))?.contentHash, first.report.contentHash, 'the earlier revision is never overwritten');

  const sent = await reports().send(first.report.id, lease());
  assert.ok(sent.status === 'sent' && sent.delivery.status === 'acknowledged', JSON.stringify(sent));
  const resent = await reports().send(first.report.id, lease());
  assert.ok(resent.status === 'sent' && resent.delivery.id === (sent as { delivery: { id: string } }).delivery.id && resent.delivery.attempts === 1, JSON.stringify(resent));
  assert.equal(await count('SELECT count(*) AS n FROM policy.report_destination_receipts'), 1, 'a retry never delivers again');
  const silent = await reports('timeout').send(changed.report.id, lease());
  assert.ok(silent.status === 'sent' && silent.delivery.status === 'uncertain' && silent.delivery.reference === null);
  const recovered = await reports().send(changed.report.id, lease());
  assert.ok(recovered.status === 'sent' && recovered.delivery.status === 'acknowledged');
  assert.equal(await count('SELECT count(*) AS n FROM policy.report_destination_receipts'), 2, 'the destination recorded the delivery once even though its answer was lost');

  const listed = await store.list({ period, destination: 'reinsurer' }, lease());
  assert.deepEqual(listed.items.map(item => item.revision), [2, 1], 'newest revision first');
  assert.equal(listed.items.find(item => item.id === first.report.id)?.delivery?.status, 'acknowledged');
  assert.equal((await store.list({ destination: 'regulator' }, lease())).items.length, 2);

  const audited = (await db.query<{ action: string }>(`SELECT DISTINCT action FROM policy.audit_events WHERE action LIKE 'reports.%'`)).rows.map(row => row.action).sort();
  assert.deepEqual(audited, ['reports.delivery.acknowledged', 'reports.delivery.dispatched', 'reports.delivery.uncertain', 'reports.download', 'reports.generate', 'reports.list', 'reports.send']);
  const rows = await count(`SELECT count(*) AS n FROM policy.audit_events WHERE action LIKE 'reports.%'`);
  await assert.rejects(store.list({}, { ...lease(), expiresAt: new Date(Date.now() - 1).toISOString() }), /report_authorization_expired/);
  assert.equal(await count(`SELECT count(*) AS n FROM policy.audit_events WHERE action LIKE 'reports.%'`), rows, 'an expired lease releases nothing and records nothing');

  await db.query(`UPDATE policy.report_revisions SET manifest = jsonb_set(manifest, '{rowCount}', '999'::JSONB) WHERE id=$1`, [changed.report.id]);
  // Not reachable by the runtime role: only an administrator could do this, and the destination still catches it.
  const tampered = await reports().send(changed.report.id, lease());
  assert.ok(tampered.status === 'sent' && tampered.delivery.status === 'acknowledged', 'a final delivery is kept even if the stored manifest is altered afterwards');
  const rejectedReport = await reports().generate({ period: '2026-01', destination: 'reinsurer' }, lease());
  await db.query(`UPDATE policy.report_revisions SET manifest = jsonb_set(manifest, '{rowCount}', '999'::JSONB) WHERE id=$1`, [rejectedReport.report.id]);
  const rejected = await reports().send(rejectedReport.report.id, lease());
  assert.ok(rejected.status === 'sent' && rejected.delivery.status === 'rejected' && rejected.delivery.rejectionCode === 'totals_mismatch');

  // The agreed timeout case of each destination's corpus, against the real simulated destination and its ledger.
  for (const destination of ['regulator', 'reinsurer'] as const) {
    const corpus = JSON.parse(await readFile(`packages/contracts/examples/report-deliveries-${destination}.json`, 'utf8')) as { cases: { fault?: string; expected: { afterLookup?: string }; message: ReportDelivery }[] };
    for (const item of corpus.cases.filter(candidate => candidate.fault === 'timeout')) {
      const message = { ...item.message, deliveryId: randomUUID() };
      const silent = new SqlMockReportDestination(destination, connection, 'timeout');
      assert.equal(await new TimerDeadline().race(silent.deliver(message), 700), 'expired', `${destination}: the answer is withheld`);
      assert.equal((await new SqlMockReportDestination(destination, connection).lookup(message.deliveryId))?.outcome, item.expected.afterLookup, `${destination}: the receipt survives`);
    }
  }

  const runtimeClient = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await runtimeClient.connect();
    await assert.rejects(runtimeClient.query(`UPDATE policy.report_revisions SET content='' WHERE id=$1`, [first.report.id]), error => error.code === '42501');
    await assert.rejects(runtimeClient.query('DELETE FROM policy.report_revisions WHERE id=$1', [first.report.id]), error => error.code === '42501');
    await assert.rejects(runtimeClient.query(`UPDATE policy.report_destination_receipts SET outcome='rejected', reference=NULL, rejection_code='hash_mismatch'`), error => error.code === '42501');
    await assert.rejects(runtimeClient.query(`INSERT INTO policy.report_revisions (id,period,destination,revision,format_version,content,content_hash,manifest,generated_at,generated_by,correlation_id)
      SELECT $1,period,destination,revision,format_version,content,$2,manifest,generated_at,generated_by,correlation_id FROM policy.report_revisions WHERE id=$3`, [randomUUID(), 'a'.repeat(64), first.report.id]), /report_revisions_period_destination_revision_key|duplicate/i);
  } finally { await runtimeClient.end(); }

  await claim('archived', '2026-10-20T00:00:00Z', null, null);
  await assert.rejects(store.facts(periodBounds(period)), error => error instanceof ReportError && error.code === 'invalid_fact', 'an unknown claim state is an error, never hidden or guessed');
  console.log(JSON.stringify({ environment: 'local', status: 'passed', cases: ['bogota-month-boundaries', 'issued-lifecycle-claims-payments', 'draft-and-pending-excluded', 'revision-by-content', 'concurrent-generation', 'period-without-data',
    'earlier-revision-kept', 'delivery-ack', 'retry-without-duplicate', 'timeout-then-lookup', 'corpus-timeout-cases', 'rejection-code', 'audit-actions', 'expired-lease', 'runtime-immutable', 'unknown-claim-state'] }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
