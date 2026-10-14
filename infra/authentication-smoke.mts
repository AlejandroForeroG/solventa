import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';
import { MobileSessions } from '../backend/identity-consent-ecosystem/src/application/mobile-sessions';
import { Authentication } from '../backend/identity-consent-ecosystem/src/application/authentication';
import { RegisteredDevices } from '../backend/identity-consent-ecosystem/src/application/registered-devices';
import { SqlRegisteredDevices } from '../backend/identity-consent-ecosystem/src/adapters/outbound/registered-devices';

// Real SQL integration in a generated, disposable local database only (ESM).
const config=await settings('local');
const name='solventa_auth_test_'+randomUUID().replaceAll('-','');
assert.match(name,/^solventa_auth_test_[a-f0-9]{32}$/);
const admin=clientFor(config.url,config.ssl);
let created=false;
let db;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); created=true;
  const url=new URL(config.url); url.pathname='/'+name;
  db=clientFor(url,config.ssl); await db.connect();
  await db.query('CREATE SCHEMA identity');
  await db.query('CREATE TABLE identity.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())');
  await applyMigrations(db,owners.find(owner=>owner.schema==='identity'));
  const state=JSON.parse(await readFile('infra/.local/runtime.local.json','utf8'));
  await db.query('GRANT CONNECT ON DATABASE '+name+' TO solventa_local_identity');
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  await db.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA identity TO solventa_local_identity');
  const runtime=new URL(url); runtime.username='solventa_local_identity'; runtime.password=state.passwords.identity;
  runtime.searchParams.set('sslmode','verify-full'); runtime.searchParams.set('sslrootcert','infra/.local/certs/ca.crt');
  const repo=new SqlIdentitySessions(runtime.toString());
  const identity={providerSubject:'synthetic_'+randomUUID(),sessionReference:'synthetic_'+randomUUID(),emailVerified:true};
  const principal=await repo.open(identity);
  assert.deepEqual(await repo.find(identity),principal);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.outbox_events')).rows[0].count,1);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.audit_events')).rows[0].count,1);
  await assert.rejects(repo.open(identity),/session_already_registered/);
  assert.deepEqual(await repo.register(identity),principal);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.audit_events')).rows[0].count,1);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.clients')).rows[0].count,1);
  await db.query("UPDATE identity.clients SET status='suspended'");
  assert.equal(await repo.find(identity),null);
  assert.equal(await repo.register(identity),null);
  await assert.rejects(repo.open({...identity,sessionReference:'synthetic_new'}),/client_inactive/);
  await db.query("UPDATE identity.clients SET status='active'");
  assert.equal(await repo.find({...identity,providerSubject:'wrong_owner'}),null);
  assert.equal(await repo.register({...identity,providerSubject:'wrong_owner'}),null);
  await repo.revoke(identity);
  assert.equal(await repo.find(identity),null);
  assert.equal(await repo.register(identity),null);
  const mobileIdentity={providerSubject:'mobile_'+randomUUID(),sessionReference:'mobile_'+randomUUID(),emailVerified:true};
  const mobileRegistrations=await Promise.all([repo.register(mobileIdentity),repo.register(mobileIdentity)]);
  assert.ok(mobileRegistrations[0]);
  assert.deepEqual(mobileRegistrations[0],mobileRegistrations[1]);
  await db.query("UPDATE identity.authentication_sessions SET created_at=now()-INTERVAL '2 seconds',expires_at=now()-INTERVAL '1 second' WHERE provider_session=$1",[mobileIdentity.sessionReference]);
  assert.equal(await repo.register(mobileIdentity),null);
  const pending={providerSubject:'pending_'+randomUUID(),sessionReference:'pending_'+randomUUID(),emailVerified:true};
  await new MobileSessions(repo).revoke(pending,randomUUID());
  assert.equal(await repo.register(pending),null);
  await repo.revokeOrBlock(pending,randomUUID());
  assert.equal((await db.query(`SELECT count(*)::INT4 FROM identity.audit_events a
    JOIN identity.authentication_sessions s ON s.id=a.resource_id WHERE s.provider_session=$1`,[pending.sessionReference])).rows[0].count,1);
  assert.equal((await db.query('SELECT revoked_at IS NOT NULL AS blocked FROM identity.authentication_sessions WHERE provider_session=$1',[pending.sessionReference])).rows[0].blocked,true);
  const tables=['clients','external_identities','authentication_sessions','audit_events','outbox_events'];
  const counts=[];
  for(const table of tables)counts.push((await db.query(`SELECT count(*)::INT4 FROM identity.${table}`)).rows[0].count);
  const failedLogout={providerSubject:'failed_logout_'+randomUUID(),sessionReference:'failed_logout_'+randomUUID(),emailVerified:true};
  await db.query('REVOKE INSERT ON identity.audit_events FROM solventa_local_identity');
  try {await assert.rejects(repo.revokeOrBlock(failedLogout,randomUUID()),/permission|privilege/i);}
  finally {await db.query('GRANT INSERT ON identity.audit_events TO solventa_local_identity');}
  for(const [index,table] of tables.entries())assert.equal((await db.query(`SELECT count(*)::INT4 FROM identity.${table}`)).rows[0].count,counts[index]);
  assert.equal(await repo.find(failedLogout),null);
  const racingLogout={providerSubject:'racing_logout_'+randomUUID(),sessionReference:'racing_logout_'+randomUUID(),emailVerified:true};
  await Promise.all([repo.register(racingLogout),repo.revokeOrBlock(racingLogout,randomUUID())]);
  assert.equal(await repo.find(racingLogout),null);
  assert.equal(await repo.register(racingLogout),null);
  await assert.rejects(repo.revokeOrBlock({...mobileIdentity,providerSubject:'wrong_logout_owner'},randomUUID()),/session_owner_mismatch/);
  await repo.revoke(identity);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.audit_events WHERE actor_reference=$1',[principal.subjectToken])).rows[0].count,2);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.authentication_sessions WHERE provider_session=$1',[mobileIdentity.sessionReference])).rows[0].count,1);
  const devices = new RegisteredDevices(new SqlRegisteredDevices(runtime.toString()));
  const deviceIdentity = {providerSubject:'device_'+randomUUID(),sessionReference:'device_'+randomUUID(),emailVerified:true};
  await repo.register(deviceIdentity);
  const deviceInput = {identity:deviceIdentity,installationId:randomUUID(),correlationId:randomUUID()};
  const binding = await devices.execute('register',deviceInput);
  assert.ok(binding);
  assert.deepEqual(await devices.execute('register',deviceInput),binding);
  assert.deepEqual(await devices.execute('find',deviceInput),binding);
  const replacementInput = {...deviceInput,installationId:randomUUID(),correlationId:randomUUID()};
  assert.equal(await devices.execute('register',replacementInput),null);
  const replacementDecision = (await db.query(`SELECT aggregate_id,payload,correlation_id FROM identity.outbox_events
    WHERE event_type='identity.device_registration_denied' AND correlation_id=$1`,[replacementInput.correlationId])).rows;
  assert.equal(replacementDecision.length,1);
  assert.equal(replacementDecision[0].payload.capture.outcome,'installation_replacement');
  assert.equal(replacementDecision[0].payload.capture.inputs.bindings[0].installationId,deviceInput.installationId);
  assert.equal(replacementDecision[0].payload.capture.inputs.installationId,replacementInput.installationId);
  assert.equal(replacementDecision[0].payload.decisionId,replacementDecision[0].aggregate_id);
  const replacementAudit = (await db.query(`SELECT resource_id,outcome,correlation_id FROM identity.audit_events
    WHERE action='device.registration_denied' AND correlation_id=$1`,[replacementInput.correlationId])).rows;
  assert.deepEqual(replacementAudit,[{resource_id:replacementDecision[0].aggregate_id,outcome:'installation_replacement',correlation_id:replacementInput.correlationId}]);
  assert.equal(await devices.execute('find',{...deviceInput,identity:{...deviceIdentity,providerSubject:'foreign'}}),null);
  const deviceCounts = await db.query(`SELECT
    (SELECT count(*)::INT4 FROM identity.registered_devices) AS devices,
    (SELECT count(*)::INT4 FROM identity.outbox_events) AS outbox,
    (SELECT count(*)::INT4 FROM identity.audit_events) AS audit`);
  const rollbackIdentity = {...deviceIdentity,sessionReference:'device_rollback_'+randomUUID()};
  await repo.register(rollbackIdentity);
  const auditBefore = (await db.query('SELECT count(*)::INT4 FROM identity.audit_events')).rows[0].count;
  const outboxBefore = (await db.query('SELECT count(*)::INT4 FROM identity.outbox_events')).rows[0].count;
  await db.query('REVOKE INSERT ON identity.audit_events FROM solventa_local_identity');
  try {
    await assert.rejects(devices.execute('register',{...deviceInput,identity:rollbackIdentity,installationId:randomUUID()}),/permission|privilege/i);
    await assert.rejects(devices.execute('register',{...replacementInput,correlationId:randomUUID()}),/permission|privilege/i);
  }
  finally { await db.query('GRANT INSERT ON identity.audit_events TO solventa_local_identity'); }
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.registered_devices')).rows[0].count,deviceCounts.rows[0].devices);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.audit_events')).rows[0].count,auditBefore);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.outbox_events')).rows[0].count,outboxBefore);
  const logoutCorrelation = randomUUID();
  await new MobileSessions(repo).revoke(deviceIdentity,logoutCorrelation);
  const logoutAudit = (await db.query(`SELECT a.correlation_id FROM identity.audit_events a
    JOIN identity.authentication_sessions s ON s.id=a.resource_id
    WHERE s.provider_session=$1 AND a.action='session.revoked'`,[deviceIdentity.sessionReference])).rows;
  assert.deepEqual(logoutAudit,[{correlation_id:logoutCorrelation}]);
  const deviceAudit = (await db.query(`SELECT correlation_id FROM identity.audit_events
    WHERE resource_id=$1 AND action='device.revoked'`,[binding.id])).rows;
  assert.deepEqual(deviceAudit,[{correlation_id:logoutCorrelation}]);
  assert.equal(await devices.execute('find',deviceInput),null);
  assert.equal(await devices.execute('register',deviceInput),null);
  assert.equal((await devices.execute('revoke',deviceInput))?.status,'revoked');
  const revoked = (await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM identity.registered_devices WHERE id=$1',[binding.id])).rows[0];
  assert.equal(revoked.revoked,true);
  const revocationEvent = (await db.query(`SELECT correlation_id,payload->'capture' AS capture FROM identity.outbox_events
    WHERE aggregate_id=$1 AND event_type='identity.device_revoked'`,[binding.id])).rows[0];
  assert.equal(revocationEvent.correlation_id,logoutCorrelation);
  const revocationCapture = revocationEvent.capture;
  assert.equal(revocationCapture.correlationId,logoutCorrelation);
  assert.equal(revocationCapture.inputs.installationId,deviceInput.installationId);
  assert.equal(revocationCapture.rule.id,'session-bound-installation');
  assert.equal(revocationCapture.outcome,'revoke');
  const deleteIdentity = {...deviceIdentity,sessionReference:'device_delete_'+randomUUID()};
  await repo.register(deleteIdentity);
  const deleteInput = {...deviceInput,identity:deleteIdentity,installationId:randomUUID()};
  assert.ok(await devices.execute('register',deleteInput));
  assert.equal((await devices.execute('revoke',deleteInput))?.status,'revoked');
  assert.equal(await repo.find(deleteIdentity),null);
  assert.equal(await repo.register(deleteIdentity),null);
  assert.equal((await devices.execute('revoke',deleteInput))?.status,'revoked');
  const oldIdentity = {...deviceIdentity,sessionReference:'device_old_'+randomUUID()};
  await repo.register(oldIdentity);
  await db.query("UPDATE identity.authentication_sessions SET created_at=now()-INTERVAL '11 minutes' WHERE provider_session=$1",[oldIdentity.sessionReference]);
  const staleInput = {...deviceInput,identity:oldIdentity,correlationId:randomUUID()};
  assert.equal(await devices.execute('register',staleInput),null);
  const staleDecision = (await db.query(`SELECT payload->'capture' AS capture FROM identity.outbox_events
    WHERE event_type='identity.device_registration_denied' AND correlation_id=$1`,[staleInput.correlationId])).rows;
  assert.equal(staleDecision.length,1);
  assert.equal(staleDecision[0].capture.outcome,'registration_window_expired');
  assert.equal(staleDecision[0].capture.inputs.registrationWindowMs,600000);
  assert.ok(staleDecision[0].capture.inputs.session.createdAt<=Date.parse(staleDecision[0].capture.inputs.evaluatedAt)-600000);
  assert.equal((await db.query(`SELECT count(*)::INT4 AS count FROM identity.audit_events
    WHERE action='device.registration_denied' AND outcome='registration_window_expired' AND correlation_id=$1`,[staleInput.correlationId])).rows[0].count,1);
  const sharedIdentity = {providerSubject:'shared_'+randomUUID(),sessionReference:'shared_'+randomUUID(),emailVerified:true};
  await repo.register(sharedIdentity);
  const sharedInput = {identity:sharedIdentity,installationId:randomUUID(),correlationId:randomUUID()};
  const sharedBinding = await devices.execute('register',sharedInput); assert.ok(sharedBinding);
  await repo.revoke({...sharedIdentity,providerSubject:'foreign'},randomUUID());
  assert.ok(await devices.execute('find',sharedInput));
  const sharedTrace = randomUUID();
  await new Authentication(repo).logout(sharedIdentity,sharedTrace);
  assert.equal(await repo.find(sharedIdentity),null);
  assert.equal(await devices.execute('find',sharedInput),null);
  assert.equal((await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM identity.registered_devices WHERE id=$1',[sharedBinding.id])).rows[0].revoked,true);
  const sharedRevocation = (await db.query(`SELECT correlation_id,payload->'capture' AS capture FROM identity.outbox_events
    WHERE aggregate_id=$1 AND event_type='identity.device_revoked'`,[sharedBinding.id])).rows;
  assert.equal(sharedRevocation.length,1);
  assert.equal(sharedRevocation[0].correlation_id,sharedTrace);
  assert.equal(sharedRevocation[0].capture.correlationId,sharedTrace);
  await new MobileSessions(repo).revoke(sharedIdentity,randomUUID());
  assert.equal((await db.query("SELECT count(*)::INT4 AS count FROM identity.audit_events WHERE resource_id=$1 AND action='device.revoked'",[sharedBinding.id])).rows[0].count,1);
  for (const repair of [repo.revoke.bind(repo),repo.revokeOrBlock.bind(repo)]) {
    const legacyIdentity = {providerSubject:'legacy_'+randomUUID(),sessionReference:'legacy_'+randomUUID(),emailVerified:true};
    await repo.register(legacyIdentity);
    const legacyInput = {identity:legacyIdentity,installationId:randomUUID(),correlationId:randomUUID()};
    const legacyBinding = await devices.execute('register',legacyInput); assert.ok(legacyBinding);
    await db.query('UPDATE identity.authentication_sessions SET revoked_at=now() WHERE provider_session=$1',[legacyIdentity.sessionReference]);
    await repair(legacyIdentity,randomUUID());
    assert.equal((await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM identity.registered_devices WHERE id=$1',[legacyBinding.id])).rows[0].revoked,true);
  }
  const rollbackWeb = {providerSubject:'rollback_web_'+randomUUID(),sessionReference:'rollback_web_'+randomUUID(),emailVerified:true};
  await repo.register(rollbackWeb);
  const rollbackWebInput = {identity:rollbackWeb,installationId:randomUUID(),correlationId:randomUUID()};
  assert.ok(await devices.execute('register',rollbackWebInput));
  const rollbackCounts = (await db.query(`SELECT
    (SELECT count(*)::INT4 FROM identity.audit_events) AS audit,
    (SELECT count(*)::INT4 FROM identity.outbox_events) AS outbox`)).rows[0];
  await db.query('REVOKE INSERT ON identity.outbox_events FROM solventa_local_identity');
  try { await assert.rejects(new Authentication(repo).logout(rollbackWeb,randomUUID()),/permission|privilege/i); }
  finally { await db.query('GRANT INSERT ON identity.outbox_events TO solventa_local_identity'); }
  assert.ok(await repo.find(rollbackWeb));
  assert.ok(await devices.execute('find',rollbackWebInput));
  assert.equal((await db.query('SELECT count(*)::INT4 AS count FROM identity.audit_events')).rows[0].count,rollbackCounts.audit);
  assert.equal((await db.query('SELECT count(*)::INT4 AS count FROM identity.outbox_events')).rows[0].count,rollbackCounts.outbox);
  const caseIdentity = {providerSubject:'case_'+randomUUID(),sessionReference:'case_'+randomUUID(),emailVerified:true};
  const casePrincipal = await repo.register(caseIdentity); assert.ok(casePrincipal);
  const upperInstallation = 'ABCDEF12-3456-4789-8ABC-DEF012345678';
  const caseInput = {identity:caseIdentity,installationId:upperInstallation,correlationId:randomUUID()};
  const caseBinding = await devices.execute('register',caseInput); assert.ok(caseBinding);
  assert.equal(caseBinding.installationId,upperInstallation.toLowerCase());
  assert.deepEqual(await devices.execute('register',{...caseInput,installationId:upperInstallation.toLowerCase()}),caseBinding);
  assert.deepEqual(await devices.execute('find',caseInput),caseBinding);
  const caseReference = (await db.query('SELECT device_reference FROM identity.registered_devices WHERE id=$1',[caseBinding.id])).rows[0].device_reference;
  assert.equal(caseReference,`mobile-v1:${caseIdentity.sessionReference}:${upperInstallation.toLowerCase()}`);
  assert.equal((await db.query("SELECT count(*)::INT4 AS count FROM identity.audit_events WHERE resource_id=$1 AND action='device.registered'",[caseBinding.id])).rows[0].count,1);
  assert.equal((await db.query("SELECT count(*)::INT4 AS count FROM identity.outbox_events WHERE aggregate_id=$1 AND event_type='identity.device_registered'",[caseBinding.id])).rows[0].count,1);
  assert.equal((await devices.execute('revoke',{...caseInput,installationId:upperInstallation.toLowerCase()}))?.status,'revoked');
  const legacyCaseIdentity = {...caseIdentity,sessionReference:'legacy_case_'+randomUUID()};
  await repo.register(legacyCaseIdentity);
  const legacyCaseId = randomUUID();
  await db.query('INSERT INTO identity.registered_devices (id,client_id,device_reference) VALUES ($1,$2,$3)',[legacyCaseId,casePrincipal.clientId,`mobile-v1:${legacyCaseIdentity.sessionReference}:${upperInstallation}`]);
  const legacyCaseInput = {identity:legacyCaseIdentity,installationId:upperInstallation.toLowerCase(),correlationId:randomUUID()};
  assert.deepEqual(await devices.execute('register',legacyCaseInput),{id:legacyCaseId,installationId:upperInstallation.toLowerCase(),status:'active'});
  assert.equal((await devices.execute('find',legacyCaseInput))?.id,legacyCaseId);
  assert.equal((await devices.execute('revoke',{...legacyCaseInput,installationId:upperInstallation}))?.id,legacyCaseId);
  assert.equal((await db.query("SELECT count(*)::INT4 AS count FROM identity.outbox_events WHERE correlation_id=$1 AND event_type='identity.device_registration_denied'",[legacyCaseInput.correlationId])).rows[0].count,0);
  console.log(JSON.stringify({authenticationSQL:'passed',checks:['verified_mapping','audit_outbox','no_duplicate','suspended_denied','ownership','revocation','mobile_retry','mobile_concurrency','expired_session_not_reopened','pending_logout_atomic','failed_logout_rollback','bootstrap_logout_race','device_binding','device_replay','device_ownership','device_audit_rollback','logout_device_revocation','device_delete_blocks_session','fresh_registration','device_denial_capture','device_denial_rollback','web_device_revocation','legacy_device_repair','web_logout_rollback','device_uuid_case','device_legacy_uuid_case']}));
} finally {
  await db?.end();
  if(created)await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
