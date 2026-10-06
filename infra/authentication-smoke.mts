import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';

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
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.clients')).rows[0].count,1);
  await db.query("UPDATE identity.clients SET status='suspended'");
  assert.equal(await repo.find(identity),null);
  await assert.rejects(repo.open({...identity,sessionReference:'synthetic_new'}),/client_inactive/);
  await db.query("UPDATE identity.clients SET status='active'");
  assert.equal(await repo.find({...identity,providerSubject:'wrong_owner'}),null);
  await repo.revoke(identity);
  assert.equal(await repo.find(identity),null);
  await repo.revoke(identity);
  assert.equal((await db.query('SELECT count(*)::INT4 FROM identity.audit_events')).rows[0].count,2);
  assert.deepEqual((await db.query('SELECT DISTINCT actor_reference FROM identity.audit_events')).rows.map(row=>row.actor_reference),[principal.subjectToken]);
  console.log(JSON.stringify({authenticationSQL:'passed',checks:['verified_mapping','audit_outbox','no_duplicate','suspended_denied','ownership','revocation']}));
} finally {
  await db?.end();
  if(created)await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
