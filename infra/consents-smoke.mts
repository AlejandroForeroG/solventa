import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, clientFor, owners, applyMigrations } from './database.mjs';
import { SqlConsents } from '../backend/identity-consent-ecosystem/src/adapters/outbound/sql-consents';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import { CURRENT_TERMS, expiryFor, sealContent } from '../backend/identity-consent-ecosystem/src/domain/consent';
import type { Consent } from '../backend/identity-consent-ecosystem/src/domain/consent';
import type { ConsentDecision } from '../backend/identity-consent-ecosystem/src/application/consents';

// Real SQL against a disposable local database, with the Identity runtime role and its grants. Synthetic data only.
const config = await settings('local');
const name = 'solventa_consent_test_' + randomUUID().replaceAll('-', '');
assert.match(name, /^solventa_consent_test_[a-f0-9]{32}$/);
const admin = clientFor(config.url, config.ssl);
let created = false;
let db;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); created = true;
  const url = new URL(config.url); url.pathname = '/' + name;
  db = clientFor(url, config.ssl); await db.connect();
  await db.query('CREATE SCHEMA identity');
  await db.query('CREATE TABLE identity.schema_migrations (version STRING PRIMARY KEY, checksum STRING NOT NULL, applied_at TIMESTAMPTZ DEFAULT now())');
  await applyMigrations(db, owners.find(owner => owner.schema === 'identity'));
  const state = JSON.parse(await readFile('infra/.local/runtime.local.json', 'utf8'));
  const grants = JSON.parse(await readFile('backend/identity-consent-ecosystem/runtime-grants.json', 'utf8')) as Record<string, string[]>;
  await db.query('GRANT CONNECT ON DATABASE ' + name + ' TO solventa_local_identity');
  await db.query('GRANT USAGE ON SCHEMA identity TO solventa_local_identity');
  for (const [table, privileges] of Object.entries(grants)) await db.query(`GRANT ${privileges.join(',')} ON identity.${table} TO solventa_local_identity`);
  const runtime = new URL(url); runtime.username = 'solventa_local_identity'; runtime.password = state.passwords.identity;
  runtime.searchParams.set('sslmode', 'verify-full'); runtime.searchParams.set('sslrootcert', 'infra/.local/certs/ca.crt');

  let current = new Date();
  const advance = (days: number) => { current = new Date(current.getTime() + days * 24 * 60 * 60 * 1000); };
  const store = new SqlConsents(runtime.toString());
  const integrity = new HmacIntegrity('synthetic-seal-key-for-the-smoke-test-0123456789');
  const consents = new Consents({
    store,
    platform: { now: () => new Date(current), newId: () => randomUUID() },
    integrity
  });
  const person = async () => {
    const principal = { clientId: randomUUID(), subjectToken: randomUUID() };
    await db.query('INSERT INTO identity.clients (id, subject_token) VALUES ($1, $2)', [principal.clientId, principal.subjectToken]);
    return principal;
  };
  const count = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0].count as number;
  const ana = await person();
  const luis = await person();
  const traceId = () => randomUUID();
  const grant = (principal: typeof ana, key: string, body: unknown = { textVersion: 2, locale: 'es-CO' }) => consents.grant({ principal, idempotencyKey: key, body, traceId: traceId() });
  const check = (principal: typeof ana, scope = 'income_obligations_12m') => consents.verify({ subjectToken: principal.subjectToken, purposeCode: 'risk_profiling', scope });
  const scopes = CURRENT_TERMS.sources.map(source => source.scope);
  const checkAll = (principal: typeof ana, using = consents) => using.verifyScopes({ subjectToken: principal.subjectToken, purposeCode: 'risk_profiling', scopes });
  const everyScope = (decision: ConsentDecision) => scopes.map(() => decision);
  const allPages = async (principal: typeof ana) => {
    const items: Awaited<ReturnType<Consents['list']>>['items'] = [];
    let after: string | undefined;
    do {
      const page = await consents.list(principal, after);
      assert.ok(page.items.length <= 50);
      items.push(...page.items); after = page.nextCursor ?? undefined;
    } while (after);
    assert.equal(new Set(items.map(c => c.consentId)).size, items.length);
    return items;
  };

  const first = await grant(ana, 'k1', { textVersion: 2, locale: 'es-CO', quoteRef: 'COT-2026-00001' });
  assert.equal(first.status, 'created');
  if (first.status !== 'created') throw Error('unreachable');
  assert.match(first.consent.consentId, /^CNS-\d{4}-\d{5}$/);
  assert.equal(await count("SELECT count(*)::INT4 FROM identity.audit_events WHERE action = 'consent.granted' AND actor_reference = $1", [ana.subjectToken]), 1);
  assert.equal(await count("SELECT count(*)::INT4 FROM identity.outbox_events WHERE event_type = 'consent.granted'"), 1);
  const row = (await db.query('SELECT sources, scopes, source, text_version, locale, wording_hash, quote_ref FROM identity.consents WHERE consent_code = $1', [first.consent.consentId])).rows[0];
  assert.deepEqual(row.sources, first.consent.sources);
  assert.equal(row.source, 'web');
  assert.equal(row.quote_ref, 'COT-2026-00001');
  assert.equal(row.locale, 'es-CO');
  assert.match(row.wording_hash, /^[0-9a-f]{64}$/);

  const replay = await grant(ana, 'k1', { textVersion: 2, locale: 'es-CO', quoteRef: 'COT-2026-00001' });
  assert.equal(replay.status, 'replayed');
  if (replay.status === 'replayed') assert.equal(replay.consent.consentId, first.consent.consentId);
  assert.deepEqual(await grant(ana, 'k1', { textVersion: 2, locale: 'es-CO', quoteRef: 'COT-2026-00002' }), { status: 'idempotency_conflict' });
  assert.equal((await grant(luis, 'k1')).status, 'created');
  for (let i = 0; i < 50; i++) assert.equal((await grant(luis, `active-${i}`)).status, 'created');
  const activeList = await allPages(luis);
  assert.equal(activeList.length, 51, 'every active authorization is reachable across bounded pages');
  assert.ok(activeList.every(c => c.status === 'active'));
  const racing = await Promise.all(Array.from({ length: 6 }, () => grant(ana, 'race')));
  assert.equal(racing.filter(r => r.status === 'created').length, 1, JSON.stringify(racing.map(r => r.status)));
  assert.equal(racing.filter(r => r.status === 'replayed').length, 5);
  assert.equal(await count('SELECT count(*)::INT4 FROM identity.consents WHERE client_id = $1', [ana.clientId]), 2);

  const allowed = await check(ana);
  assert.ok(allowed.allowed, JSON.stringify(allowed));
  assert.deepEqual(await check({ ...ana, subjectToken: randomUUID() }), { allowed: false, reason: 'consent_missing' });
  assert.deepEqual(await checkAll(ana), everyScope(allowed), 'one batch statement selects the same grant as the single check in every scope');
  assert.deepEqual(await checkAll({ ...ana, subjectToken: randomUUID() }), everyScope({ allowed: false, reason: 'consent_missing' }));

  assert.deepEqual(await consents.revoke({ principal: luis, consentCode: first.consent.consentId, traceId: traceId() }), { status: 'not_found' });
  assert.ok((await check(ana)).allowed);
  const racingRevoke = await Promise.all(Array.from({ length: 4 }, () => consents.revoke({ principal: ana, consentCode: first.consent.consentId, traceId: traceId() })));
  assert.ok(racingRevoke.every(r => r.status === 'revoked'));
  assert.equal(await count("SELECT count(*)::INT4 FROM identity.audit_events WHERE action = 'consent.revoked' AND resource_id = (SELECT id FROM identity.consents WHERE consent_code = $1)", [first.consent.consentId]), 1);
  assert.equal(await count("SELECT count(*)::INT4 FROM identity.outbox_events WHERE event_type = 'consent.revoked'"), 1);
  const stillValid = await check(ana);
  assert.ok(stillValid.allowed, 'the second consent of the same user is still valid');
  const second = (await consents.list(ana)).items.find(c => c.status === 'active');
  assert.ok(second);
  if (second) await consents.revoke({ principal: ana, consentCode: second.consentId, traceId: traceId() });
  assert.deepEqual(await check(ana), { allowed: false, reason: 'consent_revoked' });
  assert.deepEqual(await checkAll(ana), everyScope({ allowed: false, reason: 'consent_revoked' }));

  const before = await count('SELECT count(*)::INT4 FROM identity.consents');
  assert.deepEqual(await consents.decline({ principal: luis, body: { textVersion: 2 }, traceId: traceId() }), { status: 'declined' });
  assert.equal(await count('SELECT count(*)::INT4 FROM identity.consents'), before);
  assert.equal(await count("SELECT count(*)::INT4 FROM identity.audit_events WHERE action = 'consent.declined'"), 1);

  const bob = await person();
  const short = await grant(bob, 'k1');
  assert.ok(short.status === 'created');
  advance(91);
  assert.deepEqual(await checkAll(bob), everyScope({ allowed: false, reason: 'consent_expired' }));
  assert.deepEqual(await check(bob), { allowed: false, reason: 'consent_expired' });
  await check(bob); await consents.list(bob); await checkAll(bob);
  assert.equal(await count("SELECT count(*)::INT4 FROM identity.audit_events WHERE action = 'consent.expired' AND actor_reference = $1", [bob.subjectToken]), 1);
  if (short.status === 'created') assert.deepEqual(await consents.revoke({ principal: bob, consentCode: short.consent.consentId, traceId: traceId() }), { status: 'not_active' });

  const carol = await person();
  const sealed = await grant(carol, 'k1');
  assert.ok(sealed.status === 'created' && (await check(carol)).allowed);
  await db.query("UPDATE identity.consents SET expires_at = expires_at + INTERVAL '365 days' WHERE client_id = $1", [carol.clientId]);
  assert.deepEqual(await check(carol), { allowed: false, reason: 'consent_invalid' });
  assert.deepEqual(await checkAll(carol), everyScope({ allowed: false, reason: 'consent_invalid' }));

  const dave = await person();
  await grant(dave, 'k1');
  assert.ok((await checkAll(dave)).every(decision => decision.allowed));
  await db.query("UPDATE identity.clients SET status = 'suspended' WHERE id = $1", [dave.clientId]);
  assert.deepEqual(await check(dave), { allowed: false, reason: 'consent_missing' });
  assert.deepEqual(await checkAll(dave), everyScope({ allowed: false, reason: 'consent_missing' }), 'the batch reads only consents of an active owner');

  const frank = await person();
  const oldest = await grant(frank, 'k0');
  assert.ok(oldest.status === 'created');
  for (let i = 1; i <= 55; i++) {
    advance(0.001);
    const newer = await grant(frank, `k${i}`);
    assert.ok(newer.status === 'created');
    if (newer.status === 'created') await consents.revoke({ principal: frank, consentCode: newer.consent.consentId, traceId: traceId() });
  }
  const behind = await check(frank);
  assert.ok(behind.allowed && oldest.status === 'created' && behind.consent.consentId === oldest.consent.consentId, 'an older active consent is found behind more than 50 newer revoked ones');
  assert.deepEqual(await checkAll(frank), everyScope(behind), 'the batch finds it in every scope behind the same revoked ones');
  const firstPage = await consents.list(frank);
  assert.equal(firstPage.items.length, 50);
  assert.ok(firstPage.nextCursor);
  assert.equal((await consents.list(luis, firstPage.nextCursor)).items.length, 0, 'cursor ownership is checked');
  const visible = await allPages(frank);
  assert.equal(visible.length, 56, 'all authorizations remain reachable across bounded pages');
  assert.ok(oldest.status === 'created' && visible.some(c => c.consentId === oldest.consent.consentId && c.status === 'active'));
  if (oldest.status === 'created') await consents.revoke({ principal: frank, consentCode: oldest.consent.consentId, traceId: traceId() });
  assert.deepEqual(await check(frank), { allowed: false, reason: 'consent_revoked' });
  assert.deepEqual(await checkAll(frank), everyScope({ allowed: false, reason: 'consent_revoked' }));

  const erin = await person();
  assert.equal((await grant(erin, 'k1')).status, 'created');
  advance(91);
  const expiryAudits = () => count("SELECT count(*)::INT4 FROM identity.audit_events WHERE action = 'consent.expired' AND actor_reference = $1", [erin.subjectToken]);
  await db.query('REVOKE INSERT ON identity.audit_events FROM solventa_local_identity');
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    assert.deepEqual(await check(erin), { allowed: false, reason: 'consent_expired' });
    assert.deepEqual(await checkAll(erin), everyScope({ allowed: false, reason: 'consent_expired' }), 'a failed expiry audit never changes the batch answer');
  } finally {
    console.error = original;
    await db.query('GRANT INSERT ON identity.audit_events TO solventa_local_identity');
  }
  assert.ok(logged.some(line => line.includes('consent_expiry_audit_failed')), `the failed expiry audit is logged: ${JSON.stringify(logged)}`);
  assert.equal(await expiryAudits(), 0);
  await check(erin);
  assert.equal(await expiryAudits(), 1, 'the next read records the expiry that failed before');

  // A validly sealed record covering two scopes, newer than a full grant: each scope keeps its own newest
  // usable grant, so the scopes disagree until the partial record is revoked.
  const hana = await person();
  const full = await grant(hana, 'k1');
  if (full.status !== 'created') throw Error('unreachable');
  advance(0.001);
  const partialAt = new Date(current);
  const partial: Omit<Consent, 'consentCode' | 'revokedAt' | 'seal'> = { id: randomUUID(), version: 1, clientId: hana.clientId, purposeCode: 'risk_profiling',
    textVersion: 2, locale: 'es-CO', wordingHash: full.consent.wordingHash, sources: ['open_finance_bancolombia', 'datacredito_experian'],
    scopes: ['income_obligations_12m', 'payment_history_score'], grantedAt: partialAt, expiresAt: expiryFor(partialAt), quoteRef: null };
  const partialCode = 'CNS-2000-99990';
  await db.query(
    `INSERT INTO identity.consents (id, version, client_id, purpose, scopes, source, granted_at, expires_at, correlation_id, consent_code, text_version, sources, seal, idempotency_key, request_hash, locale, wording_hash)
     VALUES ($1, 1, $2, 'risk_profiling', $3, 'web', $4, $5, $6, $7, 2, $8, $9, 'partial', $10, 'es-CO', $11)`,
    [partial.id, hana.clientId, partial.scopes, partial.grantedAt, partial.expiresAt, randomUUID(), partialCode, partial.sources,
      await integrity.seal(sealContent(partial)), await integrity.digest('partial'), partial.wordingHash]);
  const mixed = await checkAll(hana);
  assert.deepEqual(mixed.map(decision => decision.allowed && decision.consent.consentId),
    [partialCode, partialCode, full.consent.consentId, full.consent.consentId], 'each scope is selected independently within one statement');
  await consents.revoke({ principal: hana, consentCode: partialCode, traceId: traceId() });
  assert.deepEqual((await checkAll(hana)).map(decision => decision.allowed && decision.consent.consentId), scopes.map(() => full.consent.consentId));

  // An uncommitted revocation is not observed; a committed one blocks the very next batch.
  const ivan = await person();
  const active = await grant(ivan, 'k1');
  if (active.status !== 'created') throw Error('unreachable');
  await db.query('BEGIN');
  await db.query('UPDATE identity.consents SET revoked_at = $2 WHERE client_id = $1', [ivan.clientId, current]);
  await db.query('ROLLBACK');
  assert.ok((await checkAll(ivan)).every(decision => decision.allowed && decision.consent.consentId === active.consent.consentId), 'a rolled-back revocation leaves the grant usable');
  await consents.revoke({ principal: ivan, consentCode: active.consent.consentId, traceId: traceId() });
  assert.deepEqual(await checkAll(ivan), everyScope({ allowed: false, reason: 'consent_revoked' }));

  // Unreachable persistence makes every scope unavailable rather than a business denial.
  const unreachable = new URL(runtime); unreachable.port = '1';
  const offline = new Consents({ store: new SqlConsents(unreachable.toString()), platform: { now: () => new Date(current), newId: () => randomUUID() }, integrity });
  assert.deepEqual(await checkAll(ivan, offline), everyScope({ allowed: false, reason: 'unavailable' }));

  // Cross the old five-digit limit and preserve exact INT8 values beyond JavaScript's safe integer range.
  current = new Date('2095-07-01T15:00:00Z');
  await db.query('INSERT INTO identity.consent_counters (year, last_value) VALUES (2095, 99998)');
  const lastFive = await grant(ana, 'capacity-99999');
  const firstSix = await grant(ana, 'capacity-100000');
  assert.ok(lastFive.status === 'created' && lastFive.consent.consentId === 'CNS-2095-99999');
  assert.ok(firstSix.status === 'created' && firstSix.consent.consentId === 'CNS-2095-100000');
  assert.equal((await check(ana)).allowed, true);
  assert.equal((await consents.revoke({ principal: ana, consentCode: 'CNS-2095-100000', traceId: traceId() })).status, 'revoked');
  await db.query('UPDATE identity.consent_counters SET last_value = $1 WHERE year = 2095', ['9007199254740991']);
  const wide = await grant(ana, 'capacity-exact-int8');
  assert.ok(wide.status === 'created' && wide.consent.consentId === 'CNS-2095-9007199254740992');

  // Restore a synthetic historical record to its v1 wording, then simulate its lost-response retry after deployment.
  const legacyOwner = await person();
  const legacyGrant = await grant(legacyOwner, 'legacy-key');
  assert.ok(legacyGrant.status === 'created');
  const legacy = (await store.forSubject(legacyOwner.subjectToken, 'risk_profiling', 'income_obligations_12m', current))[0];
  legacy.textVersion = 1;
  legacy.wordingHash = '5d51bd4f345588863206656f381e9d13ca1b420c7ce95ab7bec0e4b480c3c047';
  const legacySeal = await integrity.seal(sealContent(legacy));
  const requestHash = await integrity.digest(JSON.stringify([1, null, 'es-CO']));
  await db.query('UPDATE identity.consents SET text_version = 1, wording_hash = $2, seal = $3, request_hash = $4 WHERE id = $1', [legacy.id, legacy.wordingHash, legacySeal, requestHash]);
  const grantsBefore = await count('SELECT count(*)::INT4 FROM identity.consents');
  const eventsBefore = await count('SELECT count(*)::INT4 FROM identity.outbox_events');
  const legacyReplay = await grant(legacyOwner, 'legacy-key', { textVersion: 1, locale: 'es-CO' });
  assert.ok(legacyReplay.status === 'replayed' && legacyReplay.consent.consentId === legacyGrant.consent.consentId && legacyReplay.consent.seal === legacySeal);
  assert.equal(await count('SELECT count(*)::INT4 FROM identity.consents'), grantsBefore);
  assert.equal(await count('SELECT count(*)::INT4 FROM identity.outbox_events'), eventsBefore);
  assert.deepEqual(await grant(legacyOwner, 'legacy-key', { textVersion: 1, locale: 'en-US' }), { status: 'idempotency_conflict' });
  assert.deepEqual(await grant(legacyOwner, 'unused-legacy-key', { textVersion: 1, locale: 'es-CO' }), { status: 'terms_outdated' });
  assert.ok((await check(legacyOwner)).allowed);

  const app = clientFor(runtime, config.ssl); await app.connect();
  try {
    await assert.rejects(app.query('DELETE FROM identity.consents'), /permission|denied|privilege/i);
    await assert.rejects(app.query('UPDATE identity.audit_events SET outcome = $1', ['x']), /permission|denied|privilege/i);
  } finally { await app.end(); }

  const text = JSON.stringify((await db.query('SELECT actor_reference, action, resource_type FROM identity.audit_events')).rows)
    + JSON.stringify((await db.query('SELECT payload FROM identity.outbox_events WHERE aggregate_type = $1', ['consent'])).rows);
  assert.ok(!/@|document|nombre|name/i.test(text));

  console.log(JSON.stringify({ consentsSQL: 'passed', checks: ['grant+audit+outbox in one transaction', 'idempotent replay, conflict and concurrent retries', 'idempotency scoped to the user', 'seal verified after the round trip', 'revocation owner only and effective on the next check', 'decline audit without a consent', 'expiry denied, not revocable and audited once, a failed expiry audit logged and retried', 'an older active consent found behind more than 20 newer revoked ones', 'tampered record denied', 'suspended user denied', 'batch scope verification from one statement: same selection per scope, mixed grants, expiry audited once, rollback ignored, revocation effective on the next check, unreachable store unavailable', 'runtime role cannot delete consents or edit audit', 'no personal data stored'] }));
} finally {
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${name} CASCADE`);
  await admin.end();
}
