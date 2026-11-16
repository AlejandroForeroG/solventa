import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { changeAuditGrant } from './underwriting-audit-access.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { SqlUnderwritingAuditGrants } from '../backend/identity-consent-ecosystem/src/adapters/outbound/underwriting-audit-grants';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { SqlAuditDecisions } from '../backend/acquisition-risk/src/adapters/outbound/sql-audit-decisions';
import { AuditDecisions } from '../backend/acquisition-risk/src/application/audit-decisions';
import { historicalMortgage } from '../tests/support/audit-fixtures';
import type { OfferCapture } from '../backend/acquisition-risk/src/domain/offer';
import { SIGNAL_SCOPES } from '../backend/acquisition-risk/src/domain/signal';

const config = await settings('local');
const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const name = 'solventa_audit_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_audit_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let migrated = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  const runtime: Record<string, string> = {};
  for (const owner of owners.filter(owner => owner.schema !== 'policy')) {
    await db.query(`CREATE SCHEMA ${owner.schema}`);
    await db.query(`CREATE TABLE ${owner.schema}.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())`);
    await applyMigrations(db, owner);
    const role = `solventa_local_${owner.schema}`;
    await db.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
    await db.query(`GRANT USAGE ON SCHEMA ${owner.schema} TO ${role}`);
    await applyRuntimeGrants(db, owner, role, JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
    const connection = new URL(url); connection.username = role; connection.password = state.passwords[owner.schema];
    connection.searchParams.set('sslmode', 'verify-full'); connection.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
    runtime[owner.schema] = connection.toString();
  }
  migrated = true;
  const sessions = new SqlIdentitySessions(runtime.identity);
  const identity = { providerSubject: 'audit_synthetic_' + randomUUID(), sessionReference: 'audit_synthetic_' + randomUUID(), emailVerified: true };
  const principal = await sessions.open(identity);
  const permissions = new SqlUnderwritingAuditGrants(runtime.identity);
  const access = new ApiAccess({ find: async () => null }, sessions, permissions);
  assert.equal((await access.webUser(identity, 'underwriting-decisions:read')).allowed, false);
  const grant = { grantId: randomUUID(), clientId: principal.clientId, expiresAt: new Date(Date.now() + 3600000).toISOString(), operatorReference: randomUUID() };
  assert.equal((await changeAuditGrant(db, 'local', 'grant', grant)).changed, true);
  assert.equal((await changeAuditGrant(db, 'local', 'grant', grant)).changed, false);
  const allowed = await access.webUser(identity, 'underwriting-decisions:read');
  assert.equal(allowed.allowed, true);
  if (!allowed.allowed) throw new Error('synthetic_permission_missing');
  assert.ok(Date.parse(allowed.actor.authorizationExpiresAt!) <= Date.now() + 5000);
  const reader = () => ({ clientId: principal.clientId, traceId: randomUUID(), expiresAt: new Date(Date.now() + 5000).toISOString() });
  const store = new SqlAuditDecisions(runtime.acquisition);
  const audit = new AuditDecisions(store, { now: () => new Date() });
  const fixture = historicalMortgage();
  // Synthetic immutable captures come from the actual retained underwriting function.
  for (let index = 0; index < 23; index++) {
    const id = index === 0 ? fixture.decisionId : randomUUID();
    const snapshot = structuredClone(fixture.snapshot) as Record<string, unknown>;
    if (index === 1) delete (snapshot.inputs as Record<string, unknown>).identityVerified;
    await db.query(`INSERT INTO acquisition.underwriting_decisions (id,rule_version,contract_version,outcome,explanation,input_snapshot,correlation_id,decided_at)
      VALUES ($1,$2,'v1','accepted','{}',$3,$4,'2026-10-16T10:00:00.000Z')`, [id, fixture.ruleVersion, JSON.stringify(snapshot), fixture.correlationId]);
  }
  const revision = fixture.revisions[0];
  await db.query(`INSERT INTO acquisition.offers (id,decision_id,premium,currency,coverages,status,valid_from,expires_at) VALUES ($1,$2,$3,'COP',$4,'definitive',$5,$6)`,
  [revision.offerId, fixture.decisionId, revision.premium, JSON.stringify(revision.coverage), revision.validFrom, revision.expiresAt]);
  await db.query(`INSERT INTO acquisition.offer_revisions (offer_id,version,decision_id,premium,currency,coverages,valid_from,expires_at) VALUES ($1,1,$2,$3,'COP',$4,$5,$6)`,
  [revision.offerId, fixture.decisionId, revision.premium, JSON.stringify(revision.coverage), revision.validFrom, revision.expiresAt]);
  await db.query('UPDATE acquisition.offers SET premium=1, status=$1 WHERE id=$2', ['withdrawn', revision.offerId]);
  const detail = await audit.get(fixture.decisionId, reader());
  assert.equal(detail?.reconstruction.status, 'reconstructed');
  assert.equal(detail?.revisions[0].premium, fixture.revisions[0].premium);
  const first = await audit.list({}, reader()); assert.equal(first.items.length, 20); assert.ok(first.next);
  const second = await audit.list({ before: first.next }, reader()); assert.equal(second.items.length, 3); assert.equal(second.next, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.decisionId)).size, 23);
  const filtered = await audit.list({ reference: revision.offerId, product: 'vida_hipotecario', outcome: 'accepted', from: '2026-10-16', to: '2026-10-16' }, reader());
  assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0].decisionId, fixture.decisionId);
  assert.equal((await audit.list({ from: '2026-10-17' }, reader())).items.length, 0);
  assert.equal((await audit.list({ product: 'flight_delay' }, reader())).items.length, 0);
  const legacy = [...first.items, ...second.items].filter(item => item.decisionId !== fixture.decisionId);
  let incomplete = 0;
  for (const item of legacy) if ((await audit.get(item.decisionId, reader()))?.reconstruction.status === 'incomplete_capture') incomplete++;
  assert.equal(incomplete, 1);
  const absentTrace = reader(); assert.equal(await audit.get(randomUUID(), absentTrace), null);
  assert.equal((await db.query('SELECT outcome FROM acquisition.audit_events WHERE correlation_id=$1', [absentTrace.traceId])).rows[0].outcome, 'not_found');

  const quoteId = randomUUID(), profiledDecisionId = randomUUID();
  const oldCapture = structuredClone(fixture.snapshot) as OfferCapture;
  for (const field of ['monthlyIncomeCop', 'monthlyObligationsCop', 'identityVerified', 'affiliationActive'] as const) delete oldCapture.inputs[field];
  for (const source of oldCapture.sources) { source.source = source.source.replace('mock:', 'signal:'); source.quality = 'live'; source.confidence = 100; }
  await db.query(`INSERT INTO acquisition.quotes (id,subject_token,partner_id,client_id,idempotency_key,request_hash,normalized_request,rule_version,status,correlation_id,quote_code)
    VALUES ($1,$2,NULL,$3,'historical-profile-fixture',$4,'{}','provisional-1','completed',$5,'COT-2026-99999')`,
  [quoteId, principal.subjectToken, principal.clientId, 'a'.repeat(64), fixture.correlationId]);
  await db.query(`INSERT INTO acquisition.underwriting_decisions (id,quote_id,rule_version,contract_version,outcome,explanation,input_snapshot,correlation_id,decided_at)
    VALUES ($1,$2,$3,'v1','accepted',$4,$4,$5,$6)`, [profiledDecisionId, quoteId, fixture.ruleVersion, JSON.stringify(oldCapture), fixture.correlationId, fixture.decidedAt]);
  const facts = { income_obligations_12m: { monthlyIncomeCop: 8000000, monthlyObligationsCop: 2000000 }, payment_history_score: { score: 780 },
    affiliation_regime: { active: true }, identity_validation: { verified: true } };
  const ownerProfiles = new Set<string>();
  for (const scope of SIGNAL_SCOPES) {
    for (const foreign of [false, true]) {
      const profileId = randomUUID(); if (!foreign) ownerProfiles.add(profileId);
      const signal = { scope, capturedAt: fixture.decidedAt, data: foreign ? { monthlyIncomeCop: 1, monthlyObligationsCop: 1, score: 1, verified: false, active: false } : facts[scope] };
      await db.query(`INSERT INTO acquisition.risk_profiles (id,version,subject_token,source,captured_at,expires_at,quality,purpose,consent_id,consent_reference,consent_version,signals,correlation_id)
        VALUES ($1,1,$2,$3,$4,$5,'provider','risk_profiling',NULL,'CNS-2026-00001',1,$6,$7)`,
      [profileId, foreign ? randomUUID() : principal.subjectToken, scope, fixture.decidedAt, '2026-10-16T10:02:00.000Z', JSON.stringify(signal), fixture.correlationId]);
    }
  }
  const recovered = await audit.get(profiledDecisionId, reader());
  assert.equal(recovered?.reconstruction.status, 'reconstructed');
  assert.equal(recovered?.inputs.monthlyIncomeCop, 8000000); assert.equal(recovered?.inputs.monthlyObligationsCop, 2000000);
  assert.equal(recovered?.inputEvidence.length, 4); assert.ok(recovered?.inputEvidence.every(e => e.kind === 'retained_profile' && ownerProfiles.has(e.reference)));
  assert.equal(recovered?.quoteId, 'COT-2026-99999');
  assert.deepEqual((await db.query('SELECT input_snapshot FROM acquisition.underwriting_decisions WHERE id=$1', [profiledDecisionId])).rows[0].input_snapshot, oldCapture);

  const before = (await db.query('SELECT count(*)::INT4 AS count FROM acquisition.audit_events')).rows[0].count;
  await db.query('REVOKE INSERT ON acquisition.audit_events FROM solventa_local_acquisition');
  try {
    await assert.rejects(audit.get(fixture.decisionId, reader()), /permission|privilege/i);
    await assert.rejects(audit.get(profiledDecisionId, reader()), /permission|privilege/i);
  }
  finally { await db.query('GRANT INSERT ON acquisition.audit_events TO solventa_local_acquisition'); }
  assert.equal((await db.query('SELECT count(*)::INT4 AS count FROM acquisition.audit_events')).rows[0].count, before);
  const identityRuntimeUrl = new URL(runtime.identity);
  const identityRuntime = clientFor(identityRuntimeUrl, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await identityRuntime.connect();
    await assert.rejects(identityRuntime.query('UPDATE identity.underwriting_audit_grants SET revoked_at=now() WHERE id=$1', [grant.grantId]), error => error.code === '42501');
    await assert.rejects(identityRuntime.query('SELECT id FROM acquisition.underwriting_decisions'), error => error.code === '42501');
  } finally { await identityRuntime.end(); }
  await db.query("UPDATE identity.clients SET status='suspended' WHERE id=$1", [principal.clientId]);
  assert.equal(await permissions.find(principal, identity), null);
  await db.query("UPDATE identity.clients SET status='active' WHERE id=$1", [principal.clientId]);
  assert.equal(await permissions.find(principal, { ...identity, providerSubject: 'another-subject' }), null);
  assert.equal(await permissions.find(principal, { ...identity, sessionReference: 'another-session' }), null);
  await changeAuditGrant(db, 'local', 'revoke', { grantId: grant.grantId, operatorReference: grant.operatorReference });
  assert.equal(await permissions.find(principal, identity), null);
  assert.equal((await changeAuditGrant(db, 'local', 'revoke', { grantId: grant.grantId, operatorReference: grant.operatorReference })).changed, false);
  const rolledBackGrant = { ...grant, grantId: randomUUID() };
  const brokenAudit = { query: (sql: string, ...args: unknown[]) => sql.includes('INSERT INTO identity.audit_events') ? Promise.reject(new Error('synthetic_audit_failure')) : db!.query(sql, ...args) };
  await assert.rejects(changeAuditGrant(brokenAudit, 'local', 'grant', rolledBackGrant), /synthetic_audit_failure/);
  assert.equal((await db.query('SELECT id FROM identity.underwriting_audit_grants WHERE id=$1', [rolledBackGrant.grantId])).rowCount, 0);
  const expired = { ...grant, grantId: randomUUID(), expiresAt: new Date(Date.now() + 50000).toISOString() };
  await changeAuditGrant(db, 'local', 'grant', expired);
  await db.query("UPDATE identity.underwriting_audit_grants SET granted_at=now()-INTERVAL '2 days', expires_at=now()-INTERVAL '1 day' WHERE id=$1", [expired.grantId]);
  assert.equal(await permissions.find(principal, identity), null);
  console.log(JSON.stringify({ environment: 'local', status: 'passed', decisions: 24, cases: ['runtime-isolation', 'explicit-grant', 'revoke', 'expiry', 'session-binding', 'suspension', 'stable-pagination', 'date-filter', 'immutable-revision', 'legacy-gap', 'retained-profile-recovery', 'foreign-profile-exclusion', 'original-capture-preserved', 'durable-read-audit', 'audit-failure-closed'], providerMode: 'mock' }));
} finally {
  if (db) await db.end();
  if (created && migrated) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.log(JSON.stringify({ preservedGeneratedDatabaseForReconciliation: name }));
  await admin.end();
}
