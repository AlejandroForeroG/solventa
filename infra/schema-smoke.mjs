import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { owners, settings, clientFor, verifyIsolation, validateRuntimeGrants, applyMigrations, applyRuntimeGrants } from './database.mjs';

// Synthetic probes run only locally, within rolled-back transactions.
const config = await settings('local');
const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const checks = [];
// Build from zero in a new synthetic local database; only this generated test
// database is dropped. The developer's persistent database is never reset.
const freshName = 'solventa_schema_test_' + randomUUID().replaceAll('-', '');
assert.match(freshName, /^solventa_schema_test_[a-f0-9]{32}$/);
const freshAdmin = clientFor(config.url, config.ssl);
let created = false;
let fresh;
try {
  await freshAdmin.connect();
  await freshAdmin.query(`CREATE DATABASE ${freshName}`);
  created = true;
  const url = new URL(config.url); url.pathname = '/' + freshName;
  fresh = clientFor(url, config.ssl);
  await fresh.connect();
  for (const owner of owners) {
    console.log(JSON.stringify({ freshSchema: owner.schema, status: 'migrating' }));
    await fresh.query(`CREATE SCHEMA ${owner.schema}`);
    await fresh.query(`CREATE TABLE ${owner.schema}.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await applyMigrations(fresh, owner);
    const before = (await fresh.query(`SELECT * FROM ${owner.schema}.schema_migrations ORDER BY version`)).rows;
    await applyMigrations(fresh, owner);
    assert.deepEqual((await fresh.query(`SELECT * FROM ${owner.schema}.schema_migrations ORDER BY version`)).rows, before);
  }
  for (const owner of owners) {
    const expected = Object.keys(JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8'))).concat('schema_migrations', 'schema_migration_failures').sort();
    const actual = (await fresh.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [owner.schema])).rows.map(r => r.table_name).sort();
    assert.deepEqual(actual, expected);
  }
  // Validate the entire plan before changing any permission.
  const beforeGrants = (await fresh.query('SHOW GRANTS ON TABLE acquisition.audit_events')).rows;
  await assert.rejects(applyRuntimeGrants(fresh, owners[0], 'solventa_local_acquisition', {
    audit_events: ['SELECT'], nonexistent_probe: ['SELECT'],
  }), error => error.code === '42P01');
  assert.deepEqual((await fresh.query('SHOW GRANTS ON TABLE acquisition.audit_events')).rows, beforeGrants);
  await fresh.query('GRANT SELECT ON TABLE acquisition.audit_events TO solventa_local_acquisition');
  const grantPlan = {audit_events: ['SELECT', 'INSERT'], inbox_events: ['SELECT', 'INSERT']};
  const interrupted = {query: (sql, ...args) => {
    if (typeof sql === 'string' && sql.startsWith('GRANT') && sql.includes('inbox_events')) {
      return Promise.reject(Object.assign(Error('synthetic grant interruption'), {code: 'synthetic_interruption'}));
    }
    return fresh.query(sql, ...args);
  }};
  await assert.rejects(applyRuntimeGrants(interrupted, owners[0], 'solventa_local_acquisition', grantPlan), {code: 'synthetic_interruption'});
  assert.ok((await fresh.query('SHOW GRANTS ON TABLE acquisition.audit_events')).rows.some(row => row.grantee === 'solventa_local_acquisition' && row.privilege_type === 'SELECT'));
  await applyRuntimeGrants(fresh, owners[0], 'solventa_local_acquisition', grantPlan);
  await applyRuntimeGrants({query: (sql, ...args) => {
    assert.ok(sql.startsWith('SHOW GRANTS'), 'Unchanged runtime grants must not mutate privileges');
    return fresh.query(sql, ...args);
  }}, owners[0], 'solventa_local_acquisition', grantPlan);
  await transaction(fresh, async () => {
    await fresh.query("UPDATE acquisition.schema_migrations SET checksum=$1 WHERE version='0001_baseline.sql'", ['0'.repeat(64)]);
    await assert.rejects(applyMigrations(fresh, owners[0]), /Applied migration changed/);
  });
  assert.equal((await fresh.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rowCount, 0);
} finally {
  if (fresh) await fresh.end();
  if (created) await freshAdmin.query(`DROP DATABASE ${freshName} CASCADE`);
  await freshAdmin.end();
}
async function denied(client, sql, code) {
  await transaction(client, () => assert.rejects(client.query(sql), error => error.code === code));
}
async function transaction(client, fn) {
  await client.query('BEGIN');
  try { await fn(); } finally { await client.query('ROLLBACK'); }
}
await verifyIsolation('local');
for (const owner of owners) {
  const url = new URL(config.url);
  url.pathname = '/' + config.database;
  url.username = `solventa_local_${owner.schema}`;
  url.password = state.passwords[owner.schema];
  const client = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
  const grants = validateRuntimeGrants(JSON.parse(await readFile(`backend/${owner.name}/runtime-grants.json`, 'utf8')));
  try {
    await client.connect();
    await client.query(`SET search_path = ${owner.schema}`);
    for (const table of Object.keys(grants)) await client.query(`SELECT count(*) FROM ${table}`);
    for (const other of owners.filter(o => o !== owner)) {
      await denied(client, `SELECT * FROM ${other.schema}.audit_events`, '42501');
      await denied(client, `INSERT INTO ${other.schema}.inbox_events DEFAULT VALUES`, '42501');
      await denied(client, `UPDATE ${other.schema}.inbox_events SET consumer=consumer WHERE false`, '42501');
      await denied(client, `DELETE FROM ${other.schema}.inbox_events WHERE false`, '42501');
    }
    for (const table of Object.keys(grants)) await denied(client, `DELETE FROM ${table} WHERE false`, '42501');
    await denied(client, 'UPDATE audit_events SET action = action', '42501');
    await denied(client, 'DELETE FROM audit_events', '42501');
    await denied(client, 'UPDATE inbox_events SET consumer = consumer', '42501');
    await denied(client, 'INSERT INTO schema_migrations DEFAULT VALUES', '42501');
    await denied(client, 'SELECT * FROM schema_migration_failures', '42501');
    const event = randomUUID();
    const aggregate = randomUUID();
    const correlation = randomUUID();
    await transaction(client, async () => {
      await client.query(`INSERT INTO audit_events (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
        VALUES ('synthetic', 'probe', 'test', $1, 'passed', $2, now() + INTERVAL '1 day')`, [aggregate, correlation]);
      await client.query(`INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
        VALUES ($1, 'test', $2, 'test.created', 1, '{}', $3)`, [event, aggregate, correlation]);
      const inbox = `INSERT INTO inbox_events (event_id, consumer, event_type, event_version, outcome, correlation_id)
        VALUES ($1, $2, 'test.created', 1, 'applied', $3) ON CONFLICT DO NOTHING`;
      assert.equal((await client.query(inbox, [event, 'first', correlation])).rowCount, 1);
      assert.equal((await client.query(inbox, [event, 'first', correlation])).rowCount, 0);
      assert.equal((await client.query(inbox, [event, 'second', correlation])).rowCount, 1);
    });
    assert.equal(Number((await client.query('SELECT count(*) AS n FROM outbox_events WHERE event_id = $1', [event])).rows[0].n), 0);
    assert.equal(Number((await client.query('SELECT count(*) AS n FROM audit_events WHERE resource_id = $1', [aggregate])).rows[0].n), 0);
    if (owner.schema === 'identity') {
      const clientId = randomUUID();
      const consent = randomUUID();
      const partner = randomUUID();
      await transaction(client, async () => {
        await client.query('INSERT INTO clients (id, subject_token) VALUES ($1, $2)', [clientId, `synthetic-${clientId}`]);
        await client.query('INSERT INTO partners (id, code) VALUES ($1, $2)', [partner, `synthetic-${partner}`]);
        await client.query(`INSERT INTO consents (id, version, client_id, partner_id, purpose, scopes, source, granted_at, expires_at, correlation_id)
          VALUES ($1, 1, $2, $3, 'quote', ARRAY['signals:read'], 'synthetic', now(), now() + INTERVAL '1 day', $4)`, [consent, clientId, partner, correlation]);
        await client.query('UPDATE consents SET revoked_at = now() WHERE id = $1 AND version = 1', [consent]);
        assert.ok((await client.query('SELECT revoked_at FROM consents WHERE id = $1', [consent])).rows[0].revoked_at);
        await client.query('INSERT INTO registered_devices (client_id, device_reference) VALUES ($1, $2)', [clientId, 'synthetic-device']);
      });
      await transaction(client, async () => {
        await client.query('INSERT INTO clients (id, subject_token) VALUES ($1, $2)', [clientId, `synthetic-${clientId}`]);
        await assert.rejects(client.query(`INSERT INTO consents (id, version, client_id, purpose, scopes, source, granted_at, expires_at, correlation_id)
          VALUES ($1, 1, $2, 'quote', ARRAY['signals:read'], 'synthetic', now(), now() - INTERVAL '1 day', $3)`, [consent, clientId, correlation]), e => e.code === '23514');
      });
      await denied(client, `INSERT INTO external_identities (client_id, provider, provider_subject) VALUES ('${randomUUID()}', 'synthetic', '${randomUUID()}')`, '23503');
      await transaction(client, async () => {
        await client.query('INSERT INTO clients (id, subject_token) VALUES ($1, $2)', [clientId, `synthetic-${clientId}`]);
        await assert.rejects(client.query(`INSERT INTO consents (id, version, client_id, purpose, scopes, source, granted_at, expires_at, correlation_id)
          VALUES ($1, 1, $2, 'quote', ARRAY[]::STRING[], 'synthetic', now(), now() + INTERVAL '1 day', $3)`, [consent, clientId, correlation]), e => e.code === '23514');
      });
    }
    if (owner.schema === 'acquisition') {
      const quote = randomUUID();
      await transaction(client, async () => {
        const sql = `INSERT INTO quotes (id, subject_token, partner_id, idempotency_key, request_hash, normalized_request, rule_version, correlation_id)
          VALUES ($1, 'synthetic', $2, 'synthetic-key', $3, '{}', '1', $4) ON CONFLICT DO NOTHING`;
        const args = [quote, aggregate, 'a'.repeat(64), correlation];
        assert.equal((await client.query(sql, args)).rowCount, 1);
        assert.equal((await client.query(sql, [randomUUID(), ...args.slice(1)])).rowCount, 0);
        const decision = randomUUID(), offer = randomUUID();
        await client.query(`INSERT INTO underwriting_decisions (id, quote_id, rule_version, contract_version, outcome, explanation, input_snapshot, correlation_id)
          VALUES ($1, $2, '1', '1', 'preliminary', '{}', '{}', $3)`, [decision, quote, correlation]);
        await client.query(`INSERT INTO offers (id, decision_id, premium, currency, coverages, valid_from, expires_at)
          VALUES ($1, $2, 1, 'COP', '{}', now(), now() + INTERVAL '1 day')`, [offer, decision]);
        const archive = `INSERT INTO offer_revisions (offer_id, version, decision_id, premium, currency, coverages, valid_from, expires_at)
          SELECT id, version, decision_id, premium, currency, coverages, valid_from, expires_at FROM offers WHERE id = $1`;
        await client.query(archive, [offer]);
        await client.query('UPDATE offers SET version = 2, premium = 2 WHERE id = $1', [offer]);
        await client.query(archive, [offer]);
        assert.deepEqual((await client.query('SELECT version, premium FROM offer_revisions WHERE offer_id = $1 ORDER BY version', [offer])).rows,
          [{version: '1', premium: '1.0000'}, {version: '2', premium: '2.0000'}]);
      });
      await denied(client, 'UPDATE underwriting_decisions SET outcome = outcome', '42501');
      await denied(client, 'UPDATE offer_revisions SET premium = premium', '42501');
      await denied(client, 'UPDATE risk_profiles SET source = source', '42501');
      await transaction(client, () => assert.rejects(client.query(`INSERT INTO offers (decision_id, premium, currency, coverages, valid_from, expires_at)
        VALUES ($1, -1, 'COP', '{}', now(), now() + INTERVAL '1 day')`, [randomUUID()]), e => e.code === '23514'));
    }
    if (owner.schema === 'policy') {
      const policy = randomUUID(), otherPolicy = randomUUID(), claim = randomUUID(), indemnity = randomUUID();
      await transaction(client, async () => {
        const sql = `INSERT INTO policies (id, subject_token, offer_id, offer_version, idempotency_key, request_hash,
          premium, currency, coverage_snapshot, effective_from, effective_until, correlation_id)
          VALUES ($1, 'synthetic', $2, 1, $3, $4, 1, 'COP', '{}', now(), now() + INTERVAL '1 day', $5)`;
        for (const id of [policy, otherPolicy]) await client.query(sql, [id, aggregate, id, 'a'.repeat(64), correlation]);
        await client.query(`INSERT INTO claims (id, policy_id, idempotency_key, request_hash, occurred_at, correlation_id)
          VALUES ($1, $2, 'probe', $3, now(), $4)`, [claim, policy, 'a'.repeat(64), correlation]);
        await client.query(`INSERT INTO indemnities (id, claim_id, policy_id, amount, currency, correlation_id)
          VALUES ($1, $2, $3, 1, 'COP', $4)`, [indemnity, claim, policy, correlation]);
        const payment = `INSERT INTO payments (policy_id, indemnity_id, operation, idempotency_key, request_hash, amount, currency, correlation_id)
          VALUES ($1, $2, 'indemnity', 'probe', $3, 1, 'COP', $4) ON CONFLICT DO NOTHING`;
        assert.equal((await client.query(payment, [policy, indemnity, 'a'.repeat(64), correlation])).rowCount, 1);
        assert.equal((await client.query(payment, [policy, indemnity, 'a'.repeat(64), correlation])).rowCount, 0);
        await assert.rejects(client.query(payment, [otherPolicy, indemnity, 'a'.repeat(64), correlation]), e => e.code === '23503');
      });
      await transaction(client, () => assert.rejects(client.query(`INSERT INTO policies (subject_token, offer_id, offer_version, idempotency_key, request_hash,
        premium, currency, coverage_snapshot, effective_from, effective_until, correlation_id)
        VALUES ('synthetic', $1, 1, 'probe', $2, 1, 'COP', '{}', now(), now() - INTERVAL '1 day', $3)`,
      [aggregate, 'a'.repeat(64), correlation]), e => e.code === '23514'));
    }
    checks.push({ schema: owner.schema, tables: Object.keys(grants).length, ownRead: true, crossDmlDenied: true,
      appendOnlyAudit: true, inboxDeduplication: true, rollbackAtomicity: true });
  } finally { await client.end(); }
}
console.log(JSON.stringify({ status: 'passed', environment: 'local', freshMigration: true, replayPreservesLedger: true, schemaChecks: checks }));
