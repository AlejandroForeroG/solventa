import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants, verifyNoSchemaCreate } from './database.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { SqlIdentityVerifications } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-identity-verifications';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { KycProvider } from '../backend/identity-consent-ecosystem/src/adapters/outbound/kyc-provider';
import { SyntheticVerificationCorpus, syntheticKycSource } from '../backend/identity-consent-ecosystem/src/adapters/outbound/synthetic-identity-verification';
import { IdentityVerifications } from '../backend/identity-consent-ecosystem/src/application/identity-verifications';
import { canonicalVerificationContent, VerificationFailure } from '../backend/identity-consent-ecosystem/src/domain/identity-verification';
import type { VerificationState, VerificationView } from '../backend/identity-consent-ecosystem/src/domain/identity-verification';
import type { VerifiedIdentity } from '../backend/identity-consent-ecosystem/src/application/authentication';
import type { KycSource } from '../backend/identity-consent-ecosystem/src/adapters/outbound/kyc-provider';

// Real owner SQL and TLS in one generated local database. No shared fixtures or guards are reset.
const config = await settings('local');
const name = `solventa_kyc_test_${randomUUID().replaceAll('-', '')}`;
assert.match(name, /^solventa_kyc_test_[a-f0-9]{32}$/);
const owner = owners.find(item => item.schema === 'identity')!;
const admin = clientFor(config.url, config.ssl);
const integrity = new HmacIntegrity(randomBytes(32).toString('hex'));
const corpus = new SyntheticVerificationCorpus();
const failure = (code: string) => (error: unknown) => error instanceof VerificationFailure && error.code === code;
let created = false;
let db: ReturnType<typeof clientFor> | undefined;
const checks: string[] = [];
try {
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = `/${name}`;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA identity');
  await db.query('REVOKE ALL ON SCHEMA identity FROM public');
  await db.query('CREATE TABLE identity.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await applyMigrations(db, owner);
  const ledger = (await db.query('SELECT * FROM identity.schema_migrations ORDER BY version')).rows;
  await applyMigrations(db, owner);
  assert.deepEqual((await db.query('SELECT * FROM identity.schema_migrations ORDER BY version')).rows, ledger);
  assert.equal((await db.query('SELECT count(*)::INT4 AS count FROM identity.schema_migration_failures')).rows[0].count, 0);
  const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_identity`);
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  await applyRuntimeGrants(db, owner, 'solventa_local_identity', JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
  const runtime = new URL(url); runtime.username = 'solventa_local_identity'; runtime.password = state.passwords.identity;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const runtimeDb = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  await runtimeDb.connect();
  try {
    await verifyNoSchemaCreate(runtimeDb, 'identity');
    await assert.rejects(runtimeDb.query('DELETE FROM identity.identity_verifications WHERE false'), { code: '42501' });
    await assert.rejects(runtimeDb.query('DELETE FROM identity.identity_verification_commands WHERE false'), { code: '42501' });
    await assert.rejects(runtimeDb.query('INSERT INTO identity.schema_migrations DEFAULT VALUES'), { code: '42501' });
    await assert.rejects(runtimeDb.query('SELECT * FROM identity.schema_migration_failures'), { code: '42501' });
  } finally { await runtimeDb.end(); }
  checks.push('fresh migrations, unchanged replay, empty guards and least runtime grants');
  const sessions = new SqlIdentitySessions(runtime.toString());
  const store = new SqlIdentityVerifications(runtime.toString(), integrity);
  const providerCalls: string[] = [];
  let source: KycSource = syntheticKycSource;
  const app = new IdentityVerifications({ store, corpus, integrity, platform: { now: () => new Date(), newId: randomUUID },
    provider: new KycProvider(async (request, signal) => { providerCalls.push(request.evaluationId); return source(request, signal); }, 2500) });
  const identity: VerifiedIdentity = { providerSubject: `synthetic_${randomUUID()}`, sessionReference: `synthetic_${randomUUID()}`, emailVerified: true };
  const other: VerifiedIdentity = { providerSubject: `synthetic_${randomUUID()}`, sessionReference: `synthetic_${randomUUID()}`, emailVerified: true };
  const principal = await sessions.open(identity); await sessions.open(other);
  const context = (caseId = '', key = randomUUID(), actor = identity) => ({ identity: actor, traceId: randomUUID(), caseId, key });
  const fixture = (reference: string) => { const item = corpus.list().find(item => item.reference === reference)!;
    return { reference: item.reference, sha256: item.sha256, corpusVersion: item.corpusVersion }; };
  async function ready(document = 'document-readable') {
    let view = await app.grant(context(), { textVersion: 1, locale: 'es-CO' });
    for (const [step, reference] of [['document', document], ['selfie', 'selfie-matched'], ['liveness', 'liveness-passed']] as const) {
      view = await app.saveStep(context(view.id), step, fixture(reference), view.version);
    }
    return view;
  }
  async function saved(id: string): Promise<VerificationState> { return (await db!.query('SELECT state FROM identity.identity_verifications WHERE id=$1', [id])).rows[0].state; }
  async function seed(id: string, change: (state: VerificationState) => VerificationState) {
    const record = change(await saved(id));
    await db!.query('UPDATE identity.identity_verifications SET version=$2,state=$3,seal=$4 WHERE id=$1',
      [id, record.version, JSON.stringify(record), await integrity.seal(canonicalVerificationContent({ state: record, current: true }))]);
  }
  async function counts() {
    const result: number[] = [];
    for (const table of ['identity_verifications', 'identity_verification_commands', 'audit_events', 'outbox_events']) result.push((await db!.query(`SELECT count(*)::INT4 AS count FROM identity.${table}`)).rows[0].count);
    return result;
  }
  const grant = context();
  const simultaneous = await Promise.all([app.grant(grant, { textVersion: 1, locale: 'es-CO' }), app.grant(grant, { textVersion: 1, locale: 'es-CO' })]);
  assert.deepEqual(simultaneous[0], simultaneous[1]);
  assert.equal((await counts())[0], 1);
  assert.equal(Date.parse(simultaneous[0].expiresAt) - Date.parse(simultaneous[0].createdAt), 86400_000);
  await assert.rejects(app.grant(grant, { textVersion: 1, locale: 'en-US' }), failure('conflict'));
  await assert.rejects(app.evaluate(context(simultaneous[0].id, randomUUID(), other), 1), failure('not_found'));
  const beforeIncomplete = providerCalls.length;
  await assert.rejects(app.evaluate(context(simultaneous[0].id), 1), failure('steps_incomplete'));
  assert.equal(providerCalls.length, beforeIncomplete);
  await app.revoke(context(simultaneous[0].id));
  checks.push('concurrent grant, payload conflict, owner isolation and incomplete evidence denial');
  let view = await ready('document-unreadable');
  const beforeCommitFailure = await counts();
  await db.query('REVOKE INSERT ON identity.audit_events FROM solventa_local_identity');
  try { await assert.rejects(app.saveStep(context(view.id), 'document', fixture('document-readable'), view.version), { code: '42501' }); }
  finally { await db.query('GRANT INSERT ON identity.audit_events TO solventa_local_identity'); }
  assert.deepEqual(await counts(), beforeCommitFailure);
  assert.equal((await saved(view.id)).evidence.document?.reference, 'document-unreadable');
  const evaluation = context(view.id);
  const results = await Promise.all([app.evaluate(evaluation, view.version), app.evaluate(evaluation, view.version)]);
  assert.deepEqual(results[0], results[1]); view = results[0];
  assert.equal(view.status, 'not_verified'); assert.deepEqual(view.steps.map(item => item.step), ['selfie', 'liveness']);
  assert.equal((await db.query("SELECT count(*)::INT4 AS count FROM identity.audit_events WHERE resource_id=$1 AND action='identity_verification.evaluated'", [view.id])).rows[0].count, 1);
  const assistance = await app.requestAssistance(context(view.id), view.version);
  const repeatedAssistance = await app.requestAssistance(context(view.id), assistance.version);
  assert.deepEqual(repeatedAssistance.assistance, assistance.assistance);
  view = await app.saveStep(context(view.id), 'document', fixture('document-readable'), assistance.version);
  view = await app.evaluate(context(view.id), view.version);
  assert.equal(view.status, 'approved'); assert.equal(view.result?.simulated, true);
  assert.deepEqual(await sessions.find(identity), principal);
  assert.equal((await db.query('SELECT status FROM identity.clients WHERE id=$1', [principal.clientId])).rows[0].status, 'active');
  const validate = new Ajv({ strict: false }).compile(JSON.parse(await readFile('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
  const events = (await db.query("SELECT payload FROM identity.outbox_events WHERE aggregate_type='identity_verification'")).rows;
  for (const { payload } of events) assert.equal(validate(payload.capture), true, JSON.stringify(validate.errors));
  assert.equal(JSON.stringify(events).includes(identity.providerSubject), false);
  assert.equal(JSON.stringify(events).includes('image/png'), false);
  checks.push('transaction rollback, concurrent finalization, retained steps, one assisted reference and auditable simulation');
  await app.revoke(context(view.id)); view = await ready('document-technical');
  for (let attempt = 0; attempt < 4; attempt++) {
    view = await app.evaluate(context(view.id), view.version); assert.equal(view.status, 'unavailable'); assert.equal(view.steps.length, 3);
  }
  await app.revoke(context(view.id)); view = await ready();
  // Pause the external boundary while a separate owner transaction revokes consent.
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
  source = async (request, signal) => { entered(); await waiting; return syntheticKycSource(request, signal); };
  const inFlight = app.evaluate(context(view.id), view.version); await started;
  const processing = await app.inspect(identity, randomUUID()); assert.equal(processing?.status, 'processing'); assert.ok(processing?.pendingEvaluation);
  await app.revoke(context(view.id)); finish(); await assert.rejects(inFlight, failure('consent_inactive'));
  assert.equal((await app.inspect(identity, randomUUID()))?.status, 'revoked');
  source = syntheticKycSource;
  view = await ready();
  await seed(view.id, record => ({ ...record, createdAt: new Date(Date.now() - 86401_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const calls = providerCalls.length;
  await assert.rejects(app.evaluate(context(view.id), view.version), failure('consent_inactive'));
  assert.equal(providerCalls.length, calls);
  assert.equal((await app.inspect(identity, randomUUID()))?.steps.length, 0);
  const next = await app.grant(context(), { textVersion: 1, locale: 'es-CO' }); assert.notEqual(next.id, view.id);
  assert.deepEqual(next.steps, []);
  assert.deepEqual((await saved(view.id)).evidence, {});
  checks.push('unlimited manual technical retries, provider outside transactions, late-result revocation and expiry without reuse');
  const original = await saved(next.id);
  await db.query("UPDATE identity.identity_verifications SET state=jsonb_set(state,'{status}','\"approved\"') WHERE id=$1", [next.id]);
  await assert.rejects(app.inspect(identity, randomUUID()), /verification_state_invalid/);
  await seed(next.id, () => original);
  const command = (await db.query('SELECT idempotency_key,command FROM identity.identity_verification_commands WHERE case_id=$1 LIMIT 1', [next.id])).rows[0];
  await db.query("UPDATE identity.identity_verification_commands SET command=jsonb_set(command,'{requestHash}','\"forged\"') WHERE case_id=$1 AND idempotency_key=$2", [next.id, command.idempotency_key]);
  await assert.rejects(app.grant(context('', command.idempotency_key), { textVersion: 1, locale: 'es-CO' }), /verification_command_invalid/);
  await db.query('UPDATE identity.identity_verification_commands SET command=$3 WHERE case_id=$1 AND idempotency_key=$2', [next.id, command.idempotency_key, JSON.stringify(command.command)]);
  // Session expiry is checked using wall-clock SQL time after the owner lock, not transaction start.
  await db.query("UPDATE identity.authentication_sessions SET expires_at=now()+INTERVAL '200 milliseconds' WHERE provider_session=$1", [identity.sessionReference]);
  await db.query('BEGIN'); await db.query('SELECT id FROM identity.clients WHERE id=$1 FOR UPDATE', [principal.clientId]);
  const delayed = app.inspect(identity, randomUUID());
  await new Promise(resolve => setTimeout(resolve, 350)); await db.query('COMMIT');
  await assert.rejects(delayed, failure('unauthorized'));
  checks.push('state and command seal tampering rejected; session expiry after lock wait denied');
  console.log(JSON.stringify({ environment: 'isolated local', engine: (await db.query('SELECT version() AS version')).rows[0].version, checks, status: 'passed' }));
} finally {
  await db?.end();
  if (created) { assert.match(name, /^solventa_kyc_test_[a-f0-9]{32}$/); await admin.query(`DROP DATABASE ${name} CASCADE`); }
  await admin.end();
}
