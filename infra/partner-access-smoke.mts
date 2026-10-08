import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { changePartnerAccess } from './partner-access.mjs';
import { ApiAccess } from '../backend/identity-consent-ecosystem/src/application/api-access';
import { SqlPartnerAccess } from '../backend/identity-consent-ecosystem/src/adapters/outbound/partner-access';
import { SqlIdentitySessions } from '../backend/identity-consent-ecosystem/src/adapters/outbound/identity-sessions';

const config = await settings('local');
const name = 'solventa_access_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_access_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let db;
let operator;
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
  const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${name} TO solventa_local_identity`);
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  await applyRuntimeGrants(db, owner, 'solventa_local_identity', JSON.parse(await readFile('backend/identity-consent-ecosystem/runtime-grants.json', 'utf8')));
  const runtime = new URL(url);
  runtime.username = 'solventa_local_identity';
  runtime.password = state.passwords.identity;
  operator = clientFor(runtime, { ca: config.ssl.ca, rejectUnauthorized: true });
  await operator.connect();
  runtime.searchParams.set('sslmode', 'verify-full');
  runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');
  const repository = new SqlPartnerAccess(runtime.toString());
  const sessions = new SqlIdentitySessions(runtime.toString());
  const api = new ApiAccess(repository, sessions);
  const partner = { issuer: 'https://synthetic.authkit.app', organizationId: 'org_synthetic', applicationId: 'client_synthetic', scopes: ['quotes:create'] };
  const reference = JSON.stringify([partner.issuer, partner.organizationId, partner.applicationId]);
  const input = { partnerCode: 'synthetic-partner', provider: 'workos-connect', reference, scopes: ['quotes:create'], expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const denied = { allowed: false, error: 'forbidden', status: 403 };
  assert.deepEqual(await api.partner(partner, 'quotes:create'), denied);
  const registered = await changePartnerAccess(operator, 'local', 'register', input);
  assert.equal((await api.partner(partner, 'quotes:create')).allowed, true);
  await assert.rejects(changePartnerAccess(operator, 'local', 'register', input), /credential_exists/);
  assert.deepEqual(await api.partner({ ...partner, scopes: [] }, 'quotes:create'), denied);
  assert.deepEqual(await api.partner({ ...partner, organizationId: 'org_other' }, 'quotes:create'), denied);
  await db.query("UPDATE identity.partner_credentials SET scopes=ARRAY['unrecognized'] WHERE id=$1", [registered.credentialId]);
  assert.deepEqual(await api.partner(partner, 'quotes:create'), denied);
  await db.query("UPDATE identity.partner_credentials SET scopes=ARRAY['quotes:create'] WHERE id=$1", [registered.credentialId]);
  await db.query("UPDATE identity.partners SET status='suspended' WHERE id=$1", [registered.partnerId]);
  assert.deepEqual(await api.partner(partner, 'quotes:create'), denied);
  await assert.rejects(changePartnerAccess(operator, 'local', 'register', { ...input, reference: JSON.stringify([partner.issuer, partner.organizationId, 'client_other']) }), /partner_inactive/);
  await db.query("UPDATE identity.partners SET status='active' WHERE id=$1", [registered.partnerId]);
  await db.query("UPDATE identity.partner_credentials SET created_at=now()-INTERVAL '2 hours', expires_at=now()-INTERVAL '1 hour' WHERE id=$1", [registered.credentialId]);
  assert.deepEqual(await api.partner(partner, 'quotes:create'), denied);
  await db.query('UPDATE identity.partner_credentials SET expires_at=$1 WHERE id=$2', [input.expiresAt, registered.credentialId]);

  // Fail a real audit constraint inside the transaction; revocation must roll back.
  const connectedOperator = operator;
  const failAudit = { query: (sql: string, values?: unknown[]) => connectedOperator.query(sql.includes('INSERT INTO identity.audit_events') ? sql.replace("INTERVAL '90 days'", "INTERVAL '-1 days'") : sql, values) };
  const revoke = { provider: input.provider, reference };
  await assert.rejects(changePartnerAccess(failAudit, 'local', 'revoke', revoke));
  assert.equal((await api.partner(partner, 'quotes:create')).allowed, true);
  const beforeAudit = Number((await db.query('SELECT count(*) AS n FROM identity.audit_events')).rows[0].n);
  await changePartnerAccess(operator, 'local', 'revoke', revoke);
  assert.deepEqual(await api.partner(partner, 'quotes:create'), denied);
  assert.equal((await changePartnerAccess(operator, 'local', 'revoke', revoke)).changed, false);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM identity.audit_events')).rows[0].n), beforeAudit + 1);
  await assert.rejects(changePartnerAccess(operator, 'local', 'register', input), /credential_exists/);

  const webIdentity = { providerSubject: 'synthetic_' + randomUUID(), sessionReference: 'synthetic_' + randomUUID(), emailVerified: true };
  assert.deepEqual(await api.webUser(webIdentity, 'quotes:create'), { allowed: false, error: 'unauthorized', status: 401 });
  const principal = await sessions.open(webIdentity);
  // The only partner credential is revoked: web access must not depend on any partner registration.
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM identity.partner_credentials WHERE revoked_at IS NULL')).rows[0].n), 0);
  assert.deepEqual(await api.webUser(webIdentity, 'quotes:create'), { allowed: true, actor: { kind: 'user', channel: 'web', principal, operations: ['quotes:create'] } });
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM identity.partner_credentials')).rows[0].n), 1);
  assert.deepEqual(await api.webUser({ ...webIdentity, sessionReference: 'synthetic_' + randomUUID() }, 'quotes:create'), { allowed: false, error: 'unauthorized', status: 401 });
  assert.deepEqual(await api.webUser({ ...webIdentity, emailVerified: false }, 'quotes:create'), { allowed: false, error: 'unauthorized', status: 401 });
  await sessions.revoke(webIdentity);
  assert.deepEqual(await api.webUser(webIdentity, 'quotes:create'), { allowed: false, error: 'unauthorized', status: 401 });
  const audit = (await db.query("SELECT actor_reference FROM identity.audit_events WHERE resource_type='partner_credential'")).rows;
  assert.ok(audit.length >= 2);
  assert.ok(audit.every(row => /^partner-access-operator:[a-f0-9-]{36}$/.test(row.actor_reference)));

  const concurrentRuntime = new URL(runtime);
  concurrentRuntime.searchParams.delete('sslmode');
  concurrentRuntime.searchParams.delete('sslrootcert');
  const secondOperator = clientFor(concurrentRuntime, { ca: config.ssl.ca, rejectUnauthorized: true });
  try {
    await secondOperator.connect();
    const concurrentReference = JSON.stringify([partner.issuer, partner.organizationId, 'client_concurrent']);
    const partnerCodes = ['synthetic-concurrent-a', 'synthetic-concurrent-b'];
    const countBefore = Number((await db.query('SELECT count(*) AS n FROM identity.audit_events')).rows[0].n);
    let arrivals = 0;
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Concurrent registration synchronization timed out')), 5000);
      release = () => { clearTimeout(timer); resolve(); };
    });
    // Both independent transactions create their partner before competing for one reference.
    const synchronize = (connection: typeof operator) => ({
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO identity.partner_credentials')) {
          if (++arrivals === 2) release();
          await ready;
        }
        return connection.query(sql, values);
      },
    });
    const results = await Promise.allSettled([
      changePartnerAccess(synchronize(operator), 'local', 'register', { ...input, partnerCode: partnerCodes[0], reference: concurrentReference }),
      changePartnerAccess(synchronize(secondOperator), 'local', 'register', { ...input, partnerCode: partnerCodes[1], reference: concurrentReference }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.equal(rejected.reason.code, 'credential_exists');
    const stored = (await db.query('SELECT id,partner_id FROM identity.partner_credentials WHERE provider=$1 AND credential_reference=$2', [input.provider, concurrentReference])).rows;
    assert.equal(stored.length, 1);
    const storedPartners = (await db.query('SELECT id FROM identity.partners WHERE code IN ($1,$2)', partnerCodes)).rows;
    assert.deepEqual(storedPartners, [{ id: stored[0].partner_id }], 'The losing transaction must not leave an extra partner');
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM identity.audit_events')).rows[0].n), countBefore + 1);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM identity.audit_events WHERE resource_id=$1 AND action='partner_credential.registered'", [stored[0].id])).rows[0].n), 1);
  } finally { await secondOperator.end(); }
  console.log(JSON.stringify({ partnerAccessSQL: 'passed', checks: ['owner_runtime_grants', 'explicit_registration', 'jwt_sql_scope_intersection', 'organization_isolation', 'suspended_denied', 'expired_denied', 'revocation', 'no_reactivation', 'atomic_audit_rollback', 'audit_idempotence', 'web_user_without_partner', 'web_session_revocation', 'concurrent_registration_conflict', 'concurrent_registration_atomicity'] }));
} finally {
  await operator?.end();
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
