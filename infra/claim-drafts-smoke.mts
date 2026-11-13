import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlClaimDrafts } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-drafts';
import { SqlClaimReport } from '../backend/policy-claims-payments/src/adapters/outbound/sql-claim-report';
import { canonicalDraftCommand, type DraftCommand, type DraftContent, type DraftResult } from '../backend/policy-claims-payments/src/domain/claim-draft';
import { Hono } from 'hono';
import { ClaimDrafts } from '../backend/policy-claims-payments/src/application/claim-drafts';
import { mountClaimDrafts } from '../backend/policy-claims-payments/src/adapters/inbound/claim-drafts-http';
import { createDraftApi } from '../apps/mobile/src/features/claim-drafts/adapters/draft-api';
import { DraftSync } from '../apps/mobile/src/features/claim-drafts/application/draft-sync';
import { EncryptedDraftStorage } from '../apps/mobile/src/features/claim-drafts/adapters/encrypted-draft-storage';
import { draftCustody } from '../tests/support/draft-custody';

const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const name = 'solventa_claim_drafts_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_claim_drafts_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let db: ReturnType<typeof clientFor> | undefined;
try {
  await admin.connect();
  const held = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA policy');
  await db.query('CREATE TABLE policy.schema_migrations(version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())');
  const owner = owners.find(o => o.schema === 'policy')!;
  await applyMigrations(db, owner); await applyMigrations(db, owner);
  const grants = JSON.parse(await readFile('backend/policy-claims-payments/runtime-grants.json', 'utf8')) as Record<string, string[]>;
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_policy`);
  await db.query('GRANT USAGE ON SCHEMA policy TO solventa_local_policy');
  for (const [table, privileges] of Object.entries(grants)) await db.query(`GRANT ${privileges.join(',')} ON policy.${table} TO solventa_local_policy`);
  const runtime = new URL(url); runtime.username = 'solventa_local_policy'; runtime.password = held.passwords.policy;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const store = new SqlClaimDrafts(runtime.toString());
  const actor = { clientId: randomUUID(), subjectToken: randomUUID() };
  const stranger = { clientId: randomUUID(), subjectToken: randomUUID() };
  const policyId = randomUUID();
  await db.query(`INSERT INTO policy.policies (id, subject_token, offer_id, offer_version, idempotency_key, request_hash, status, premium, currency, coverage_snapshot, effective_from, effective_until, correlation_id)
    VALUES ($1,$2,$3,1,'drafts-fixture',$4,'issued',100000,'COP','{}',now()-INTERVAL '1 day',now()+INTERVAL '1 year',$5)`, [policyId, actor.subjectToken, randomUUID(), 'a'.repeat(64), randomUUID()]);
  const content: DraftContent = { policyId, eventType: 'other', occurredAt: null, place: '', description: 'Synthetic initial note', evidence: [] };
  const id = randomUUID();
  const command = (baseRevision: number, change: Partial<DraftContent> = {}): DraftCommand => ({ commandId: randomUUID(), baseRevision, content: { ...content, ...change } });
  const sync = (draftId: string, cmd: DraftCommand, who = actor) => store.sync({ owner: who, draftId, command: cmd,
    requestHash: createHash('sha256').update(canonicalDraftCommand(draftId, cmd)).digest('hex'), traceId: randomUUID() });
  const confirmed = (result: DraftResult) => { assert.equal(result.status, 'confirmed', JSON.stringify(result)); if (result.status !== 'confirmed') throw Error('expected confirmed'); return result.draft; };

  const first = command(0);
  const simultaneous = await Promise.all([sync(id, first), sync(id, first)]);
  assert.equal(confirmed(simultaneous[0]).revision, 1);
  assert.deepEqual(simultaneous[0], simultaneous[1]);
  assert.equal((await sync(id, first, { ...actor, clientId: randomUUID() })).status, 'not_found', 'replay also checks both owner coordinates');
  assert.equal((await sync(id, { ...first, content: { ...content, description: 'changed intent' } })).status, 'idempotency_conflict');
  assert.equal((await store.list(stranger)).length, 0); assert.equal(await store.get(stranger, id), null);
  assert.equal((await sync(id, command(1), stranger)).status, 'policy_unavailable');
  assert.equal((await sync(randomUUID(), command(9))).status, 'invalid_base');
  assert.equal(confirmed(await sync(id, command(1, { description: 'Server edit' }))).revision, 2);
  const automatic = await sync(id, command(1, { place: 'Concurrent place' }));
  const version = confirmed(automatic);
  assert.equal(version.revision, 3); assert.equal(version.content.description, 'Server edit'); assert.equal(version.content.place, 'Concurrent place');
  assert.ok(automatic.status === 'confirmed' && automatic.merged);

  const conflicted = await sync(id, command(1, { description: 'Offline edit' }));
  assert.equal(conflicted.status, 'conflict');
  if (conflicted.status !== 'conflict') throw Error('expected conflict');
  assert.equal((await store.get(actor, id))?.revision, 3, 'a conflict never overwrites the draft');
  assert.equal(conflicted.conflict.base?.revision, 1);
  assert.equal(conflicted.conflict.server.revision, 3);
  const resolution: DraftCommand = { commandId: randomUUID(), baseRevision: 3, content: conflicted.conflict.local,
    resolution: { conflictId: conflicted.conflict.conflictId, keep: 'local' } };
  // Another writer advances the same field before the saved choice reaches the server.
  const another = { ...version.content, description: 'Newer server edit' };
  confirmed(await sync(id, { commandId: randomUUID(), baseRevision: 3, content: another }));
  const again = await sync(id, resolution);
  assert.equal(again.status, 'conflict');
  if (again.status !== 'conflict') throw Error('expected another conflict');
  assert.equal(again.conflict.server.revision, 4);
  const choice: DraftCommand = { commandId: randomUUID(), baseRevision: 4, content: again.conflict.local,
    resolution: { conflictId: again.conflict.conflictId, keep: 'local' } };
  const settled = confirmed(await sync(id, choice));
  assert.equal(settled.content.description, 'Offline edit'); assert.equal(settled.content.place, 'Concurrent place');
  const restarted = new SqlClaimDrafts(runtime.toString());
  assert.deepEqual(await restarted.sync({ owner: actor, draftId: id, command: choice,
    requestHash: createHash('sha256').update(canonicalDraftCommand(id, choice)).digest('hex'), traceId: randomUUID() }), { status: 'confirmed', draft: settled, merged: false });

  const deniedReference = await sync(id, command(settled.revision, { evidence: [{ claimId: randomUUID(), fileId: randomUUID() }] }));
  assert.equal(deniedReference.status, 'evidence_unavailable');
  assert.equal((await store.get(actor, id))?.revision, settled.revision);
  // Real mobile coordinator, encrypted custody coordinator, HTTP use case and SQL transaction.
  // Only native custody and Identity's bearer decision are test doubles in this process.
  const app = new Hono<{ Bindings: PolicyEnv }>();
  mountClaimDrafts(app, { drafts: new ClaimDrafts(store, { sha256Hex: async text => createHash('sha256').update(text).digest('hex') }),
    authorize: async input => input.token === 'synthetic.jwt.token' ? { allowed: true, actor: { kind: 'user', channel: 'mobile', principal: actor, operations: ['claims:report'] } }
      : { allowed: false, status: 401, error: 'unauthorized' } });
  const nativeCustody = draftCustody(); let loseResponse = true;
  const api = createDraftApi('https://staging.solventa.site', { execute: operation => operation('synthetic.jwt.token') }, async (url, init) => {
    const response = await app.fetch(new Request(url, init), {} as PolicyEnv);
    if (init?.method === 'PUT' && loseResponse) { loseResponse = false; throw Error('synthetic response loss after commit'); }
    return response;
  });
  const createMobile = () => new DraftSync({ storage: new EncryptedDraftStorage('https://staging.solventa.site', nativeCustody.port), api, newId: randomUUID, now: Date.now });
  const mobileId = randomUUID(); let mobile = createMobile(); await mobile.open(actor); await mobile.save(mobileId, content); mobile.lock();
  mobile = createMobile(); await mobile.open(actor); await mobile.sync(actor);
  let snapshot = mobile.getSnapshot(); assert.equal(snapshot.status, 'ready');
  if (snapshot.status !== 'ready') throw Error('mobile unavailable');
  assert.equal(snapshot.entries[0].status, 'failed'); const retainedCommand = snapshot.entries[0].command;
  assert.equal((await store.get(actor, mobileId))?.revision, 1);
  mobile.lock(); mobile = createMobile(); await mobile.open(actor); await mobile.sync(actor);
  snapshot = mobile.getSnapshot(); if (snapshot.status !== 'ready') throw Error('mobile unavailable');
  assert.equal(snapshot.entries[0].status, 'confirmed');
  assert.equal((await db.query('SELECT * FROM policy.claim_draft_revisions WHERE draft_id=$1', [mobileId])).rowCount, 1);
  assert.equal((await db.query('SELECT * FROM policy.claim_draft_commands WHERE draft_id=$1 AND command_id=$2', [mobileId, retainedCommand!.commandId])).rowCount, 1);
  const current = confirmed(await sync(mobileId, { commandId: randomUUID(), baseRevision: 1, content: { ...content, description: 'Remote competing edit' } }));
  await mobile.save(mobileId, { ...content, description: 'Offline competing edit' }); await mobile.sync(actor);
  snapshot = mobile.getSnapshot(); if (snapshot.status !== 'ready') throw Error('mobile unavailable');
  assert.equal(snapshot.entries[0].status, 'conflict'); assert.equal((await store.get(actor, mobileId))?.revision, current.revision);
  await mobile.resolve(mobileId, 'server'); mobile.lock(); mobile = createMobile(); await mobile.open(actor); await mobile.sync(actor);
  snapshot = mobile.getSnapshot(); if (snapshot.status !== 'ready') throw Error('mobile unavailable');
  assert.equal(snapshot.entries[0].status, 'confirmed'); assert.equal(snapshot.entries[0].content.description, 'Remote competing edit');
  assert.equal((await store.get(actor, mobileId))?.revision, current.revision, 'keeping the server creates no artificial data revision');
  const reports = new SqlClaimReport(runtime.toString()), fileId = randomUUID();
  const report = await reports.createDraft({ owner: actor, idempotencyKey: randomUUID(), requestHash: 'd'.repeat(64), traceId: randomUUID(), report: {
    policyId, eventType: 'other', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), place: 'Synthetic location',
    description: 'Synthetic evidence reference for the editable claim draft.', evidence: [{ fileId, contentType: 'image/jpeg', byteSize: 128, sha256: 'e'.repeat(64) }] } });
  if (report.status !== 'created') throw Error('report fixture failed');
  const reference = { claimId: report.claim.claimId, fileId };
  const referencedId = randomUUID(), referenceCommand = command(0, { evidence: [reference] });
  assert.equal((await sync(referencedId, referenceCommand)).status, 'evidence_unavailable', 'pending metadata is not a valid reference');
  assert.ok(await reports.markVerified(actor, reference.claimId, fileId, randomUUID()));
  assert.deepEqual((await store.evidence(actor, policyId)).map(({ claimId, fileId }) => ({ claimId, fileId })), [reference]);
  assert.deepEqual(await store.evidence(stranger, policyId), []);
  const referenced = confirmed(await sync(referencedId, referenceCommand));
  assert.equal(confirmed(await sync(referencedId, command(1, { evidence: [reference] }))).revision, referenced.revision,
    'JSONB key ordering cannot manufacture a data revision for unchanged evidence');
  confirmed(await sync(referencedId, command(1, { evidence: [reference], description: 'Synthetic competing server note' })));
  const referenceConflict = await sync(referencedId, command(1, { evidence: [reference], description: 'Synthetic competing local note' }));
  if (referenceConflict.status !== 'conflict') throw Error('expected evidence-bearing conflict');
  const referenceChoice = confirmed(await sync(referencedId, { commandId: randomUUID(), baseRevision: 2, content: referenceConflict.conflict.local,
    resolution: { conflictId: referenceConflict.conflict.conflictId, keep: 'local' } }));
  assert.equal(referenceChoice.content.description, 'Synthetic competing local note');
  assert.deepEqual(referenceChoice.content.evidence, [reference]);
  await db.query('UPDATE policy.evidence_metadata SET created_at=now()-INTERVAL \'2 days\', retention_until=now()-INTERVAL \'1 second\' WHERE claim_id=$1', [reference.claimId]);
  assert.deepEqual(await store.evidence(actor, policyId), []);
  assert.equal((await sync(referencedId, command(referenced.revision, { description: 'Synthetic newer local note' }))).status, 'evidence_unavailable',
    'a conflict cannot advertise an expired server reference as a valid version');
  assert.equal((await store.get(actor, referencedId))?.revision, referenceChoice.revision);
  const captures = (await db.query('SELECT result FROM policy.claim_draft_commands WHERE draft_id=$1', [id])).rows;
  assert.ok(captures.some(({ result }) => result.response.status === 'conflict' && result.capture.inputs.serverRevision >= 2));
  assert.ok(captures.some(({ result }) => result.capture.inputs.resolution?.keep === 'local'));
  assert.ok(captures.every(({ result }) => result.capture.rule.id === 'claim-draft.fields' && !JSON.stringify(result.capture).includes('Offline edit')));
  await db.query(`ALTER TABLE policy.audit_events ADD CONSTRAINT reject_draft_audit CHECK (action <> 'claims.draft.sync') NOT VALID`);
  await assert.rejects(sync(id, command(settled.revision, { description: 'Must roll back with the audit' })));
  assert.equal((await store.get(actor, id))?.revision, settled.revision);
  await db.query('ALTER TABLE policy.audit_events DROP CONSTRAINT reject_draft_audit');
  await db.query("UPDATE policy.policies SET status='cancelled' WHERE id=$1", [policyId]);
  assert.equal((await sync(id, first)).status, 'policy_unavailable', 'replay cannot restore withdrawn policy access');
  assert.equal(await store.get(actor, id), null);
  const native = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true }); await native.connect();
  try {
    assert.equal((await native.query('SELECT current_user')).rows[0].current_user, 'solventa_local_policy');
    await assert.rejects(native.query('DELETE FROM policy.claim_drafts'));
    await assert.rejects(native.query("UPDATE policy.claim_draft_revisions SET revision=999 WHERE draft_id=$1", [id]));
    await assert.rejects(native.query("UPDATE policy.claim_draft_commands SET request_hash=$1", ['b'.repeat(64)]));
  } finally { await native.end(); }
  console.log(JSON.stringify({ suite: 'claim-drafts-sql', result: 'passed', cases: ['fresh migration/replay', 'concurrent duplicate', 'payload conflict', 'owner isolation', 'three-way merge', 'manual conflict', 'second concurrency', 'choice replay after restart', 'invalid/expired evidence', 'audit rollback', 'withdrawn access', 'minimum grants', 'mobile encrypted queue restart/response loss/single SQL effect', 'mobile conflict/server choice', 'decision capture'] }));
} finally {
  if (db) await db.end();
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
