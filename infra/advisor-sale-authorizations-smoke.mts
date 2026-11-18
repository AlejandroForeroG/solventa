import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { SqlAdvisorSaleAuthorizations } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-advisor-sale-authorizations';

// Real local Identity SQL with the least-privilege runtime role; the web session that identifies the customer is an input here.
const config = await settings('local');
const name = 'solventa_advisor_sale_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_advisor_sale_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
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
  const store = new SqlAdvisorSaleAuthorizations(runtime.toString());

  const insert = async (table: string, columns: string, values: unknown[]) => (await db.query(`INSERT INTO identity.${table} (${columns}) VALUES (${values.map((_, index) => '$' + (index + 1)).join(',')}) RETURNING id`, values)).rows[0].id as string;
  const customerOf = async (id: string) => ({ clientId: id, subjectToken: (await db.query('SELECT subject_token FROM identity.clients WHERE id=$1', [id])).rows[0].subject_token as string });
  const ana = await customerOf(await insert('clients', 'subject_token', [randomUUID()]));
  const luis = await customerOf(await insert('clients', 'subject_token', [randomUUID()]));
  const advisorClient = await customerOf(await insert('clients', 'subject_token', [randomUUID()]));
  const otherAdvisorClient = await customerOf(await insert('clients', 'subject_token', [randomUUID()]));
  const revokedAdvisorClient = await customerOf(await insert('clients', 'subject_token', [randomUUID()]));
  const days = (count: number) => new Date(Date.now() + count * 86400000);
  const advisor = await insert('policy_advisor_grants', 'client_id, expires_at, granted_by', [advisorClient.clientId, days(30), randomUUID()]);
  const otherAdvisor = await insert('policy_advisor_grants', 'client_id, expires_at, granted_by', [otherAdvisorClient.clientId, days(30), randomUUID()]);
  const revokedAdvisor = await insert('policy_advisor_grants', 'client_id, expires_at, granted_by', [revokedAdvisorClient.clientId, days(30), randomUUID()]);
  const now = () => new Date();
  const hours = (count: number) => new Date(Date.now() + count * 3600000);
  const counts = async () => ({
    audit: Number((await db.query("SELECT count(*) AS n FROM identity.audit_events WHERE resource_type='advisor_sale_authorization'")).rows[0].n),
    outbox: Number((await db.query("SELECT count(*) AS n FROM identity.outbox_events WHERE aggregate_type='advisor_sale_authorization'")).rows[0].n)
  });

  // Granting needs a current advisor who is not the customer, and writes the row, its audit and its outbox event in one transaction.
  assert.equal(await store.grant({ principal: ana, advisorReference: randomUUID(), grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }), null);
  assert.equal(await store.grant({ principal: advisorClient, advisorReference: advisor, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }), null, 'an advisor cannot authorize themselves');
  await db.query('UPDATE identity.policy_advisor_grants SET revoked_at = now() WHERE id = $1', [revokedAdvisor]);
  assert.equal(await store.grant({ principal: ana, advisorReference: revokedAdvisor, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }), null, 'a revoked advisor cannot be authorized');
  assert.deepEqual(await counts(), { audit: 0, outbox: 0 });
  const granted = await store.grant({ principal: ana, advisorReference: advisor, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
  assert.ok(granted);
  assert.deepEqual([granted.advisorReference, granted.operation, granted.revokedAt], [advisor, 'advisor-sale:prepare', null]);
  assert.deepEqual(await counts(), { audit: 1, outbox: 1 });
  const audit = (await db.query("SELECT actor_reference, action, resource_id FROM identity.audit_events WHERE resource_type='advisor_sale_authorization'")).rows[0];
  assert.deepEqual([audit.actor_reference, audit.action, audit.resource_id], [ana.subjectToken, 'advisor_sale_authorization.granted', granted.id]);

  // A failing audit rolls the whole grant back: no authorization without its evidence.
  const before = Number((await db.query('SELECT count(*) AS n FROM identity.advisor_sale_authorizations')).rows[0].n);
  await db.query("ALTER TABLE identity.audit_events ADD CONSTRAINT synthetic_block CHECK (action <> 'advisor_sale_authorization.granted') NOT VALID");
  const blocked = await store.grant({ principal: ana, advisorReference: advisor, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }).then(() => 'committed', () => 'rolled_back');
  await db.query('ALTER TABLE identity.audit_events DROP CONSTRAINT IF EXISTS synthetic_block');
  assert.equal(blocked, 'rolled_back');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM identity.advisor_sale_authorizations')).rows[0].n), before, 'a failed audit leaves no authorization');

  // Only the exact advisor holding the authorization resolves the customer behind it.
  assert.deepEqual(await store.find(advisor, granted.id), { clientId: ana.clientId, subjectToken: ana.subjectToken, expiresAt: granted.expiresAt.toISOString() });
  assert.equal(await store.find(otherAdvisor, granted.id), null, 'another advisor cannot use it');
  assert.equal(await store.find(advisor, randomUUID()), null);

  // Ownership: a customer lists and revokes only their own rows.
  const other = await store.grant({ principal: luis, advisorReference: otherAdvisor, grantedAt: now(), expiresAt: hours(48), traceId: randomUUID() });
  assert.ok(other);
  assert.deepEqual((await store.list(ana, 50)).map(row => row.id), [granted.id]);
  assert.deepEqual((await store.list(luis, 50)).map(row => row.id), [other.id]);
  assert.deepEqual(await store.revoke(ana, other.id, now(), randomUUID()), { kind: 'not_found' });
  assert.equal(await store.find(otherAdvisor, other.id) !== null, true, "a denied revoke leaves the other customer's authorization intact");

  // Revocation takes effect on the next use, is idempotent and is recorded once.
  const auditBefore = (await counts()).audit;
  const revoked = await store.revoke(ana, granted.id, now(), randomUUID());
  assert.equal(revoked.kind, 'revoked');
  assert.equal(await store.find(advisor, granted.id), null);
  assert.equal((await store.revoke(ana, granted.id, now(), randomUUID())).kind, 'already_revoked');
  assert.equal((await counts()).audit, auditBefore + 1, 'revoking twice records one event');

  // Expiry and a closed customer each stop the use.
  const short = await store.grant({ principal: ana, advisorReference: advisor, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
  assert.ok(short);
  assert.equal(await store.find(advisor, short.id) !== null, true);
  await db.query("UPDATE identity.advisor_sale_authorizations SET granted_at = now() - INTERVAL '2 days', expires_at = now() - INTERVAL '1 day' WHERE id = $1", [short.id]);
  assert.equal(await store.find(advisor, short.id), null, 'an expired authorization is unusable');
  assert.equal((await store.revoke(ana, short.id, now(), randomUUID())).kind, 'expired');
  const live = await store.grant({ principal: ana, advisorReference: advisor, grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
  assert.ok(live);
  await db.query("UPDATE identity.clients SET status='closed' WHERE id=$1", [ana.clientId]);
  assert.equal(await store.find(advisor, live.id), null, 'a closed customer cannot be priced');
  await db.query("UPDATE identity.clients SET status='active' WHERE id=$1", [ana.clientId]);
  assert.equal(await store.find(advisor, live.id) !== null, true);

  // The schema itself bounds the grant, and the runtime role cannot delete or rewrite history.
  await assert.rejects(db.query("INSERT INTO identity.advisor_sale_authorizations (advisor_grant_id, client_id, operation, expires_at) VALUES ($1, $2, 'advisor-sale:prepare', now() + INTERVAL '8 days')", [advisor, ana.clientId]), /check constraint|violates/i);
  await assert.rejects(db.query("INSERT INTO identity.advisor_sale_authorizations (advisor_grant_id, client_id, operation, expires_at) VALUES ($1, $2, 'offers:accept', now() + INTERVAL '1 day')", [advisor, ana.clientId]), /check constraint|violates/i);
  await assert.rejects(runtimeClient.query('DELETE FROM identity.advisor_sale_authorizations WHERE id=$1', [live.id]), /privilege|denied/i);
  console.log(JSON.stringify({ advisorSaleAuthorizationsSQL: 'passed', checks: ['owner_runtime_grants', 'atomic_audit_outbox', 'exact_advisor_lookup', 'customer_ownership', 'idempotent_revocation', 'expiry', 'closed_customer', 'schema_bounds'] }));
} finally {
  await runtimeClient?.end();
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
