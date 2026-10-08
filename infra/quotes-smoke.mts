import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor } from './database.mjs';
import { SqlQuoteStore } from '../backend/acquisition-risk/src/adapters/outbound/sql-quote-store';
import { HmacProtector } from '../backend/acquisition-risk/src/adapters/outbound/hmac-protector';
import { CreateQuote } from '../backend/acquisition-risk/src/application/create-quote';
import type { AccessCredential, AccessDecision, ApiAccess } from '../backend/acquisition-risk/src/application/ports/api-access';

// Local SQL only, with the acquisition runtime role so its grants are exercised. Identity is a stand-in.
// Synthetic rows are removed afterwards with the administrative connection.
const config = await settings('local');
assert.equal(config.database, 'solventa_local');
const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
const url = new URL(config.url); url.pathname = '/' + config.database;
const runtime = new URL(url); runtime.username = 'solventa_local_acquisition'; runtime.password = state.passwords.acquisition;
runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');

const partnerId = randomUUID();
const users = [{ clientId: randomUUID(), subjectToken: randomUUID() }, { clientId: randomUUID(), subjectToken: randomUUID() }];
const access: ApiAccess = {
  async authorize(credential: AccessCredential): Promise<AccessDecision> {
    if (credential.kind === 'partner') return { allowed: true, actor: { kind: 'partner', partnerId } };
    return { allowed: true, actor: { kind: 'user', ...users[credential.cookie === 'second' ? 1 : 0] } };
  }
};
const PARTNER: AccessCredential = { kind: 'partner', token: 'token' };
const WEB = (cookie: string): AccessCredential => ({ kind: 'web', cookie, origin: 'http://localhost:8787', method: 'POST' });

const admin = clientFor(url, config.ssl);
await admin.connect();
const documentNumber = String(Math.floor(1e9 + Math.random() * 8e9));
const traces: string[] = [];
const protector = new HmacProtector('local-smoke-secret-'.padEnd(40, 'x'));
const useCase = new CreateQuote({ access, store: new SqlQuoteStore(runtime.toString()), clock: { now: () => new Date() }, protector });
const request = { product: 'vida_hipotecario', customer: { fullName: 'Cliente Sintetico Smoke', documentType: 'CC', documentNumber, birthDate: '1992-03-14', city: 'Bogotá D.C.' }, credit: { partnerCreditId: 'CRE-SMOKE', amount: 320000000, termMonths: 180 } };
const call = (credential: AccessCredential, idempotencyKey: string, body: unknown = request) => {
  const traceId = randomUUID(); traces.push(traceId);
  return useCase.execute({ credential, idempotencyKey, body, traceId });
};

try {
  for (const [label, credential] of [['partner', PARTNER], ['web user', WEB('first')]] as const) {
    const key = `smoke-${label}-${randomUUID()}`;
    const first = await call(credential, key);
    assert.equal(first.status, 'created', label);
    if (first.status !== 'created') throw Error('unreachable');
    assert.match(first.quote.quoteId, /^COT-\d{4}-\d{5}$/);
    assert.equal(first.quote.premiumMonthly, 86400); // born 1992: band 31-40 until 2032

    const replay = await call(credential, key);
    assert.equal(replay.status, 'replayed', label);
    if (replay.status === 'replayed') assert.equal(replay.quote.quoteId, first.quote.quoteId);
    assert.equal((await call(credential, key, { ...request, credit: { ...request.credit, amount: 1000000 } })).status, 'idempotency_conflict', label);

    assert.equal((await call(credential, key, { ...request, customer: { ...request.customer, documentNumber: '1099999999' } })).status, 'idempotency_conflict', `${label}: same key, other customer`);

    const racing = `race-${label}-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => call(credential, racing)));
    assert.equal(results.filter(r => r.status === 'created').length, 1, `${label}: ${JSON.stringify(results.map(r => r.status))}`);
    assert.equal(results.filter(r => r.status === 'replayed').length, 5, label);
  }

  // The same key for another user is another quote: idempotency is scoped to the actor.
  const shared = `shared-${randomUUID()}`;
  assert.equal((await call(WEB('first'), shared)).status, 'created');
  assert.equal((await call(WEB('second'), shared)).status, 'created');
  assert.equal((await call(WEB('first'), shared)).status, 'replayed');

  const rows = await admin.query(
    `SELECT id, partner_id, client_id, subject_token, quote_code, normalized_request::TEXT AS normalized, result::TEXT AS result, request_hash
     FROM acquisition.quotes WHERE correlation_id = ANY($1::UUID[])`, [traces]);
  const dump = JSON.stringify(rows.rows);
  for (const secret of [documentNumber, 'Cliente Sintetico', '1992-03-14']) assert.ok(!dump.includes(secret), 'no personal data stored in plain text');
  assert.ok(rows.rows.every(r => r.request_hash.length === 64));
  const partnerRows = rows.rows.filter(r => r.partner_id === partnerId);
  const userRows = rows.rows.filter(r => r.partner_id === null);
  assert.equal(partnerRows.length, 2, 'partner: one quote for the base key and one for the race key');
  assert.ok(partnerRows.every(r => r.client_id === null));
  assert.equal(userRows.length, 4, 'web user: base key, race key, and the shared key for two users');
  assert.ok(userRows.every(r => users.some(u => u.clientId === r.client_id && u.subjectToken === r.subject_token)), 'web quotes hang from the session user');

  const ids = rows.rows.map(r => r.id);
  const audits = await admin.query('SELECT count(*)::INT4 AS n FROM acquisition.audit_events WHERE resource_id = ANY($1::UUID[])', [ids]);
  const outbox = await admin.query("SELECT count(*)::INT4 AS n, bool_and(payload::TEXT NOT LIKE '%' || $2 || '%') AS clean FROM acquisition.outbox_events WHERE aggregate_id = ANY($1::UUID[])", [ids, documentNumber]);
  assert.equal(audits.rows[0].n, ids.length);
  assert.equal(outbox.rows[0].n, ids.length);
  assert.equal(outbox.rows[0].clean, true);

  const probe = clientFor(runtime, { ca: (config.ssl as { ca?: string }).ca, rejectUnauthorized: true });
  await probe.connect();
  try {
    const insert = (partner: string | null, client: string | null) => probe.query(
      "INSERT INTO acquisition.quotes (subject_token, partner_id, client_id, idempotency_key, request_hash, normalized_request, rule_version, status, correlation_id) VALUES ('t', $1, $2, $3, $4, '{}', 'r', 'completed', $5)",
      [partner, client, `constraint-${randomUUID()}`, 'a'.repeat(64), randomUUID()]);
    await probe.query('BEGIN'); await assert.rejects(insert(null, null), /CHECK constraint/); await probe.query('ROLLBACK');
    await probe.query('BEGIN'); await assert.rejects(insert(randomUUID(), randomUUID()), /CHECK constraint/); await probe.query('ROLLBACK');
    await assert.rejects(probe.query('DELETE FROM acquisition.quotes'), /privilege|permission|denied/i);
  } finally { await probe.end(); }
  console.log(JSON.stringify({ status: 'passed', checks: ['quote+audit+outbox in one transaction, for partner and web user', 'idempotent replay and key reuse conflict per actor, also with another customer', 'concurrent retries create one quote', 'idempotency scoped to the actor', 'web quotes hang from the session user', 'no personal data stored', 'exactly one actor per quote', 'runtime role cannot delete'] }));
} finally {
  const ids = (await admin.query('SELECT id FROM acquisition.quotes WHERE correlation_id = ANY($1::UUID[])', [traces])).rows.map(r => r.id);
  await admin.query('DELETE FROM acquisition.outbox_events WHERE aggregate_id = ANY($1::UUID[])', [ids]);
  await admin.query('DELETE FROM acquisition.audit_events WHERE resource_id = ANY($1::UUID[])', [ids]);
  await admin.query('DELETE FROM acquisition.quotes WHERE id = ANY($1::UUID[])', [ids]);
  await admin.end();
}
