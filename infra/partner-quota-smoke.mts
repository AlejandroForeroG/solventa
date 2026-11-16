import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { SqlPartnerQuotas, readPartnerQuota } from '../backend/identity-consent-ecosystem/src/adapters/outbound/partner-quotas';
import { changePartnerQuota } from './partner-quota.mjs';

// Real local Identity SQL with the least-privilege runtime role; the web session that identifies the customer is an input here.
const config = await settings('local');
const name = 'solventa_partner_quotas_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_partner_quotas_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let migrationsComplete = false;
let db;
let runtimeClient;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const url = new URL(config.url);
  url.pathname = '/' + name;
  db = clientFor(url, config.ssl);
  await db.connect();
  await db.query('CREATE SCHEMA identity');
  await db.query('CREATE TABLE identity.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())');
  const owner = owners.find(candidate => candidate.schema === 'identity');
  assert.ok(owner);
  await applyMigrations(db, owner);
  await applyMigrations(db, owner);
  migrationsComplete = true;
  const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_identity`);
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  await applyRuntimeGrants(db, owner, 'solventa_local_identity', JSON.parse(await readFile('backend/identity-consent-ecosystem/runtime-grants.json', 'utf8')));
  const runtime = new URL(url);
  runtime.username = 'solventa_local_identity';
  runtime.password = state.passwords.identity;
  runtimeClient = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  await runtimeClient.connect();
  runtime.searchParams.set('sslmode', 'verify-full');
  runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const quotas = new SqlPartnerQuotas(runtime.toString());
  const a=(await db.query("INSERT INTO identity.partners(code) VALUES('quota-a') RETURNING id")).rows[0].id;
  const b=(await db.query("INSERT INTO identity.partners(code) VALUES('quota-b') RETURNING id")).rows[0].id;
  const operatorReference=randomUUID();
  const snapshot=()=>readPartnerQuota(runtimeClient,a);
  assert.equal((await snapshot()).limit,1000);
  assert.equal((await snapshot()).used,0);
  await changePartnerQuota(db,'local',{partnerId:a,operatorReference,dailyLimit:3});
  const race=await Promise.all(Array.from({length:7},()=>quotas.admit(a)));
  assert.equal(race.filter(r=>r.allowed).length,3,JSON.stringify(race));
  assert.equal((await snapshot()).used,3);
  const denied=await quotas.admit(a);assert.equal(denied.allowed,false);
  if(!denied.allowed){assert.equal(denied.status,429);if(denied.status===429) assert.ok(denied.retryAfter>=1&&denied.retryAfter<=86400);}
  assert.equal((await quotas.admit(b)).allowed,true);
  assert.equal((await readPartnerQuota(runtimeClient,b)).used,1);
  await changePartnerQuota(db,'local',{partnerId:a,operatorReference,dailyLimit:1});
  assert.equal((await snapshot()).used,3);assert.equal((await snapshot()).remaining,0);
  assert.equal((await quotas.admit(a)).allowed,false);
  const auditBefore=(await db.query("SELECT count(*)::INT4 AS n FROM identity.audit_events WHERE action='partner_quota.changed'")).rows[0].n;
  await db.query("ALTER TABLE identity.audit_events ADD CONSTRAINT block_quota CHECK(action<>'partner_quota.changed') NOT VALID");
  try{await assert.rejects(changePartnerQuota(db,'local',{partnerId:a,operatorReference,dailyLimit:8}));}
  finally{await db.query('ALTER TABLE identity.audit_events DROP CONSTRAINT block_quota');}
  assert.equal((await snapshot()).limit,1);
  assert.equal((await db.query("SELECT count(*)::INT4 AS n FROM identity.audit_events WHERE action='partner_quota.changed'")).rows[0].n,auditBefore);
  for(const table of ['partner_quota_policy','partner_quota_overrides']) await assert.rejects(runtimeClient.query(`UPDATE identity.${table} SET daily_limit=8`),/privilege|denied/i);
  await db.query('REVOKE UPDATE ON identity.partner_quota_windows FROM solventa_local_identity');
  try{assert.deepEqual(await quotas.admit(b),{allowed:false,error:'access_unavailable',status:503});}
  finally{await db.query('GRANT UPDATE ON identity.partner_quota_windows TO solventa_local_identity');}
  assert.equal((await readPartnerQuota(runtimeClient,b)).used,1);
  await db.query('DELETE FROM identity.partner_quota_policy');
  assert.deepEqual(await quotas.admit(b),{allowed:false,error:'access_unavailable',status:503});
  await assert.rejects(readPartnerQuota(runtimeClient,b),/quota_configuration_unavailable/);
  assert.equal((await db.query('SELECT used::INT4 AS used FROM identity.partner_quota_windows WHERE partner_id=$1',[b])).rows[0].used,1);
  console.log(JSON.stringify({partnerQuotaSQL:'passed',checks:['default_1000','atomic_concurrent_cap','shared_partner_counter','isolation','lower_limit_preserves_usage','admin_audit_rollback','runtime_isolation','counter_failure_blocks','missing_configuration_blocks']}));
} finally {
  await runtimeClient?.end();
  await db?.end();
  if (created && migrationsComplete) await admin.query(`DROP DATABASE ${name} CASCADE`);
  else if (created) console.error(JSON.stringify({partnerQuotaSQL:'migration_failed',preservedDatabase:name,reconciliationRequired:true}));
  await admin.end();
}
