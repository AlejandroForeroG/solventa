import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations, applyRuntimeGrants } from './database.mjs';
import { SqlPartnerAuthorizations } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-partner-authorizations';

// Real local Identity SQL with the least-privilege runtime role; the web session that identifies the customer is an input here.
const config = await settings('local');
const name = 'solventa_partner_authorizations_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_partner_authorizations_test_[a-f0-9]{32}$/);
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
  const store = new SqlPartnerAuthorizations(runtime.toString());

  const insert = async (table: string, columns: string, values: unknown[]) => (await db.query(`INSERT INTO identity.${table} (${columns}) VALUES (${values.map((_, index) => '$' + (index + 1)).join(',')}) RETURNING id`, values)).rows[0].id as string;
  const acme = await insert('partners', 'code', ['acme']);
  const globex = await insert('partners', 'code', ['globex']);
  const suspended = await insert('partners', 'code, status', ['suspended-partner', 'suspended']);
  const ana = { clientId: await insert('clients', 'subject_token', [randomUUID()]), subjectToken: '' };
  const luis = { clientId: await insert('clients', 'subject_token', [randomUUID()]), subjectToken: '' };
  for (const customer of [ana, luis]) customer.subjectToken = (await db.query('SELECT subject_token FROM identity.clients WHERE id=$1', [customer.clientId])).rows[0].subject_token;
  const now = () => new Date();
  const hours = (count: number) => new Date(Date.now() + count * 3600000);
  const counts = async () => ({
    audit: Number((await db.query("SELECT count(*) AS n FROM identity.audit_events WHERE resource_type='partner_authorization'")).rows[0].n),
    outbox: Number((await db.query("SELECT count(*) AS n FROM identity.outbox_events WHERE aggregate_type='partner_authorization'")).rows[0].n)
  });

  // Granting needs an active partner and writes the row, its audit and its outbox event in one transaction.
  assert.equal(await store.grant({ principal: ana, partnerCode: 'unknown', grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }), null);
  assert.equal(await store.grant({ principal: ana, partnerCode: 'suspended-partner', grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }), null);
  assert.deepEqual(await counts(), { audit: 0, outbox: 0 });
  const granted = await store.grant({ principal: ana, partnerCode: 'acme', grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
  assert.ok(granted);
  assert.deepEqual([granted.partnerCode, granted.operation, granted.revokedAt], ['acme', 'partner-offers:create', null]);
  assert.deepEqual(await counts(), { audit: 1, outbox: 1 });
  const audit = (await db.query("SELECT actor_reference, action, resource_id FROM identity.audit_events WHERE resource_type='partner_authorization'")).rows[0];
  assert.deepEqual([audit.actor_reference, audit.action, audit.resource_id], [ana.subjectToken, 'partner_authorization.granted', granted.id]);

  // A failing audit rolls the whole grant back: no authorization without its evidence.
  const before = Number((await db.query('SELECT count(*) AS n FROM identity.partner_authorizations')).rows[0].n);
  await db.query("ALTER TABLE identity.audit_events ADD CONSTRAINT synthetic_block CHECK (action <> 'partner_authorization.granted') NOT VALID");
  const blocked = await store.grant({ principal: ana, partnerCode: 'acme', grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() }).then(() => 'committed', () => 'rolled_back');
  await db.query('ALTER TABLE identity.audit_events DROP CONSTRAINT IF EXISTS synthetic_block');
  assert.equal(blocked, 'rolled_back');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM identity.partner_authorizations')).rows[0].n), before, 'a failed audit leaves no authorization');

  // Only the exact partner holding the authorization resolves the customer behind it.
  assert.deepEqual(await store.find(acme, granted.id), { clientId: ana.clientId, subjectToken: ana.subjectToken, expiresAt: granted.expiresAt.toISOString() });
  assert.equal(await store.find(globex, granted.id), null, 'another partner cannot use it');
  assert.equal(await store.find(acme, randomUUID()), null);

  // Ownership: a customer lists and revokes only their own rows.
  const lunes = await store.grant({ principal: luis, partnerCode: 'globex', grantedAt: now(), expiresAt: hours(48), traceId: randomUUID() });
  assert.ok(lunes);
  assert.deepEqual((await store.list(ana, 50)).map(row => row.id), [granted.id]);
  assert.deepEqual((await store.list(luis, 50)).map(row => row.id), [lunes.id]);
  assert.deepEqual(await store.revoke(ana, lunes.id, now(), randomUUID()), { kind: 'not_found' });
  assert.equal(await store.find(globex, lunes.id) !== null, true, "a denied revoke leaves the other customer's authorization intact");

  // Revocation takes effect on the next use, is idempotent and is recorded once.
  const auditBefore = (await counts()).audit;
  const revoked = await store.revoke(ana, granted.id, now(), randomUUID());
  assert.equal(revoked.kind, 'revoked');
  assert.equal(await store.find(acme, granted.id), null);
  assert.equal((await store.revoke(ana, granted.id, now(), randomUUID())).kind, 'already_revoked');
  assert.equal((await counts()).audit, auditBefore + 1, 'revoking twice records one event');

  // Expiry, suspended partner and closed customer each stop the use.
  const short = await store.grant({ principal: ana, partnerCode: 'acme', grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
  assert.ok(short);
  assert.equal(await store.find(acme, short.id) !== null, true);
  await db.query("UPDATE identity.partner_authorizations SET granted_at = now() - INTERVAL '2 days', expires_at = now() - INTERVAL '1 day' WHERE id = $1", [short.id]);
  assert.equal(await store.find(acme, short.id), null, 'an expired authorization is unusable');
  assert.equal((await store.revoke(ana, short.id, now(), randomUUID())).kind, 'expired');
  const live = await store.grant({ principal: ana, partnerCode: 'acme', grantedAt: now(), expiresAt: hours(24), traceId: randomUUID() });
  assert.ok(live);
  await db.query("UPDATE identity.partners SET status='suspended' WHERE id=$1", [acme]);
  assert.equal(await store.find(acme, live.id), null, 'a suspended partner cannot use any authorization');
  await db.query("UPDATE identity.partners SET status='active' WHERE id=$1", [acme]);
  await db.query("UPDATE identity.clients SET status='closed' WHERE id=$1", [ana.clientId]);
  assert.equal(await store.find(acme, live.id), null, 'a closed customer cannot be priced');
  await db.query("UPDATE identity.clients SET status='active' WHERE id=$1", [ana.clientId]);
  assert.equal(await store.find(acme, live.id) !== null, true);
  assert.equal(await store.find(suspended, live.id), null);

  // The schema itself bounds the grant, and the runtime role cannot delete or rewrite history.
  await assert.rejects(db.query("INSERT INTO identity.partner_authorizations (partner_id, client_id, operation, expires_at) VALUES ($1, $2, 'partner-offers:create', now() + INTERVAL '91 days')", [acme, ana.clientId]), /check constraint/i);
  await assert.rejects(db.query("INSERT INTO identity.partner_authorizations (partner_id, client_id, operation, expires_at) VALUES ($1, $2, 'offers:accept', now() + INTERVAL '1 day')", [acme, ana.clientId]), /check constraint/i);
  await assert.rejects(runtimeClient.query('DELETE FROM identity.partner_authorizations WHERE id=$1', [live.id]), /privilege|denied/i);
  console.log(JSON.stringify({ partnerAuthorizationsSQL: 'passed', checks: ['owner_runtime_grants', 'atomic_audit_outbox', 'exact_partner_lookup', 'customer_ownership', 'idempotent_revocation', 'expiry', 'inactive_partner_or_customer', 'schema_bounds', 'no_runtime_delete'] }));
} finally {
  await runtimeClient?.end();
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
