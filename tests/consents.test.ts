import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Consents } from '../backend/identity-consent-ecosystem/src/application/consents';
import { HmacIntegrity } from '../backend/identity-consent-ecosystem/src/adapters/outbound/hmac-integrity';
import { CURRENT_TERMS, WORDING_FINGERPRINT, sealContent, statusOf } from '../backend/identity-consent-ecosystem/src/domain/consent';
import { ANA, LUIS, MemoryConsents, SEAL_KEY, TRACE, clock } from './support/consent-fakes';

function setup(key = SEAL_KEY) {
  const store = new MemoryConsents();
  const time = clock();
  return { store, time, consents: new Consents({ store, platform: time, integrity: new HmacIntegrity(key) }) };
}
const grant = (consents: Consents, over: Partial<{ principal: typeof ANA; idempotencyKey: string | null; body: unknown }> = {}) =>
  consents.grant({ principal: ANA, idempotencyKey: 'key-1', body: { textVersion: 2, locale: 'es-CO' }, traceId: TRACE, ...over });
const check = (over: Partial<{ subjectToken: string; purposeCode: string; scope: string }> = {}) =>
  ({ subjectToken: ANA.subjectToken, purposeCode: 'risk_profiling', scope: 'income_obligations_12m', ...over });

test('a grant covers exactly the sources and scopes of the text version, lasts 90 days and is sealed', async () => {
  const { consents } = setup();
  const result = await grant(consents, { body: { textVersion: 2, locale: 'es-CO', quoteRef: 'COT-2026-00001' } });
  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;
  assert.deepEqual(result.consent.sources, CURRENT_TERMS.sources.map(s => s.code));
  assert.deepEqual(result.consent.scopes, CURRENT_TERMS.sources.map(s => s.scope));
  assert.equal(Date.parse(result.consent.expiresAt) - Date.parse(result.consent.grantedAt), 90 * 24 * 60 * 60 * 1000);
  assert.match(result.consent.consentId, /^CNS-2026-\d{5}$/);
  assert.match(result.consent.seal, /^[0-9a-f]{64}$/);
  assert.equal(result.consent.status, 'active');
  assert.equal(result.consent.quoteRef, 'COT-2026-00001');
});

test('the year of the code follows the Bogota calendar, not UTC', async () => {
  // 2027-01-01T03:00Z is still 22:00 on 31 December in Bogota.
  const late = new Consents({ store: new MemoryConsents(), platform: clock('2027-01-01T03:00:00Z'), integrity: new HmacIntegrity(SEAL_KEY) });
  const result = await grant(late);
  assert.ok(result.status === 'created' && result.consent.consentId.startsWith('CNS-2026-'), JSON.stringify(result));
});

test('a retry with the same key returns the same consent; another request with that key is a conflict', async () => {
  const { consents, store } = setup();
  const first = await grant(consents);
  const retry = await grant(consents);
  assert.equal(retry.status, 'replayed');
  if (first.status === 'created' && retry.status === 'replayed') assert.equal(retry.consent.consentId, first.consent.consentId);
  assert.deepEqual(await grant(consents, { body: { textVersion: 2, locale: 'es-CO', quoteRef: 'COT-2026-00002' } }), { status: 'idempotency_conflict' });
  assert.equal(store.consents.length, 1);
  assert.equal(store.audit.filter(e => e.action === 'consent.granted').length, 1);
});

test('the same key used by two users creates two consents', async () => {
  const { consents, store } = setup();
  assert.equal((await grant(consents)).status, 'created');
  assert.equal((await grant(consents, { principal: LUIS })).status, 'created');
  assert.equal(store.consents.length, 2);
});

test('an outdated text version is refused and nothing is written', async () => {
  const { consents, store } = setup();
  assert.deepEqual(await grant(consents, { body: { textVersion: 3, locale: 'es-CO' } }), { status: 'terms_outdated' });
  assert.deepEqual(await consents.decline({ principal: ANA, body: { textVersion: 0 }, traceId: TRACE }), { status: 'invalid' });
  assert.deepEqual(await consents.decline({ principal: ANA, body: { textVersion: 3 }, traceId: TRACE }), { status: 'terms_outdated' });
  assert.equal(store.consents.length + store.audit.length, 0);
});

test('malformed requests are invalid: missing key, long key, unknown or mistyped fields', async () => {
  const { consents, store } = setup();
  for (const idempotencyKey of [null, '', 'x'.repeat(129)]) assert.deepEqual(await grant(consents, { idempotencyKey }), { status: 'invalid' });
  for (const body of [null, 'x', [], {}, { textVersion: '1', locale: 'es-CO' }, { textVersion: 2.5, locale: 'es-CO' }, { textVersion: 2 }, { textVersion: 2, locale: 'fr-FR' }, { textVersion: 2, locale: null }, { textVersion: 2, locale: 'es-CO', subjectToken: 'x' }, { textVersion: 2, locale: 'es-CO', quoteRef: 'COT-26-1' }, { textVersion: 2, locale: 'es-CO', clientId: ANA.clientId }]) {
    assert.deepEqual(await grant(consents, { body }), { status: 'invalid' }, JSON.stringify(body));
  }
  assert.equal((await grant(consents, { idempotencyKey: 'x'.repeat(128) })).status, 'created');
  assert.equal(store.consents.length, 1);
});

test('declining creates no consent and leaves one audit event', async () => {
  const { consents, store } = setup();
  assert.deepEqual(await consents.decline({ principal: ANA, body: { textVersion: 2 }, traceId: TRACE }), { status: 'declined' });
  assert.equal(store.consents.length, 0);
  assert.deepEqual(store.audit, [{ action: 'consent.declined', subjectToken: ANA.subjectToken }]);
  assert.equal((await consents.verify(check())).allowed, false);
});

test('the panel lists only the consents of the user, newest first, with status computed from the dates', async () => {
  const { consents, time } = setup();
  await grant(consents, { idempotencyKey: 'old' });
  time.advance(95);
  await grant(consents, { idempotencyKey: 'new' });
  await grant(consents, { principal: LUIS });
  const items = await consents.list(ANA);
  assert.deepEqual(items.map(i => i.status), ['active', 'expired']);
  assert.equal((await consents.list(LUIS)).length, 1);
});

test('revoking stops the next use; revoking twice returns the same record; another user cannot revoke it', async () => {
  const { consents, time } = setup();
  const created = await grant(consents);
  assert.ok(created.status === 'created');
  if (created.status !== 'created') return;
  const code = created.consent.consentId;
  assert.equal((await consents.verify(check())).allowed, true);
  assert.deepEqual(await consents.revoke({ principal: LUIS, consentCode: code, traceId: TRACE }), { status: 'not_found' });
  assert.equal((await consents.verify(check())).allowed, true, 'a foreign revoke changes nothing');

  time.advance(1);
  const revoked = await consents.revoke({ principal: ANA, consentCode: code, traceId: TRACE });
  assert.ok(revoked.status === 'revoked' && revoked.consent.status === 'revoked' && revoked.consent.revokedAt);
  assert.deepEqual(await consents.verify(check()), { allowed: false, reason: 'consent_revoked' });

  time.advance(1);
  const again = await consents.revoke({ principal: ANA, consentCode: code, traceId: TRACE });
  assert.ok(again.status === 'revoked' && revoked.status === 'revoked' && again.consent.revokedAt === revoked.consent.revokedAt);
  assert.deepEqual(await consents.revoke({ principal: ANA, consentCode: 'nope', traceId: TRACE }), { status: 'invalid' });
});

test('every active authorization remains listed and revocable beyond the history cap', async () => {
  const { consents, time } = setup();
  const oldest = await grant(consents, { idempotencyKey: 'oldest' });
  assert.ok(oldest.status === 'created');
  for (let i = 0; i < 55; i++) {
    time.advance(0.001);
    const newer = await grant(consents, { idempotencyKey: `newer-${i}` });
    assert.ok(newer.status === 'created');
    await consents.revoke({ principal: ANA, consentCode: newer.consent.consentId, traceId: TRACE });
  }
  const items = await consents.list(ANA);
  assert.equal(items.length, 51);
  assert.ok(items.some(c => c.consentId === oldest.consent.consentId && c.status === 'active'));
  assert.equal((await consents.revoke({ principal: ANA, consentCode: oldest.consent.consentId, traceId: TRACE })).status, 'revoked');
  assert.equal((await consents.verify(check())).allowed, false);
  assert.equal((await consents.list(LUIS)).length, 0);

  for (let i = 0; i < 51; i++) await grant(consents, { idempotencyKey: `active-${i}` });
  const allActive = (await consents.list(ANA)).filter(c => c.status === 'active');
  assert.equal(allActive.length, 51, 'the cap applies only to inactive history');
});

test('version 1 grants keep their original sealed validity after the wording revision', async () => {
  const { consents, store } = setup();
  await grant(consents);
  const legacy = store.consents[0];
  legacy.textVersion = 1;
  legacy.wordingHash = '5d51bd4f345588863206656f381e9d13ca1b420c7ce95ab7bec0e4b480c3c047';
  legacy.seal = await new HmacIntegrity(SEAL_KEY).seal(sealContent(legacy));
  const decision = await consents.verify(check());
  assert.ok(decision.allowed && decision.consent.textVersion === 1);
  assert.deepEqual(await grant(consents, { idempotencyKey: 'stale', body: { textVersion: 1, locale: 'es-CO' } }), { status: 'terms_outdated' });
  assert.equal((await consents.revoke({ principal: ANA, consentCode: legacy.consentCode, traceId: TRACE })).status, 'revoked');
});

test('an expired consent cannot be revoked and is denied on use', async () => {
  const { consents, time } = setup();
  const created = await grant(consents);
  time.advance(90);
  assert.deepEqual(await consents.verify(check()), { allowed: false, reason: 'consent_expired' });
  if (created.status === 'created') assert.deepEqual(await consents.revoke({ principal: ANA, consentCode: created.consent.consentId, traceId: TRACE }), { status: 'not_active' });
});

test('use is allowed only with an active consent for the same subject, purpose and scope', async () => {
  const { consents } = setup();
  assert.deepEqual(await consents.verify(check()), { allowed: false, reason: 'consent_missing' });
  await grant(consents);
  const allowed = await consents.verify(check({ scope: 'identity_validation' }));
  assert.ok(allowed.allowed && /^CNS-2026-\d{5}$/.test(allowed.consent.consentId) && allowed.consent.textVersion === 2);
  assert.deepEqual(await consents.verify(check({ subjectToken: LUIS.subjectToken })), { allowed: false, reason: 'consent_missing' });
  for (const over of [{ scope: 'credit_card_balance' }, { purposeCode: 'advertising' }, { subjectToken: 'not-a-uuid' }]) {
    assert.deepEqual(await consents.verify(check(over)), { allowed: false, reason: 'invalid_request' }, JSON.stringify(over));
  }
  assert.deepEqual(await consents.verify(null as never), { allowed: false, reason: 'invalid_request' });
});

test('a record changed after the grant is denied: the seal no longer matches', async () => {
  const { consents, store } = setup();
  await grant(consents);
  store.consents[0].expiresAt = new Date(store.consents[0].expiresAt.getTime() + 365 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await consents.verify(check()), { allowed: false, reason: 'consent_invalid' });
});

test('a valid consent is found even when a newer one is revoked', async () => {
  const { consents, time } = setup();
  await grant(consents, { idempotencyKey: 'a' });
  time.advance(1);
  const newer = await grant(consents, { idempotencyKey: 'b' });
  time.advance(1);
  if (newer.status === 'created') await consents.revoke({ principal: ANA, consentCode: newer.consent.consentId, traceId: TRACE });
  assert.equal((await consents.verify(check())).allowed, true);
});

test('if the store or the seal key is unavailable nothing is granted and use is denied', async () => {
  const { consents, store } = setup();
  await grant(consents);
  store.failing = true;
  assert.deepEqual(await consents.verify(check()), { allowed: false, reason: 'unavailable' });
  await assert.rejects(grant(consents, { idempotencyKey: 'k2' }));

  const noKey = setup('short');
  await assert.rejects(grant(noKey.consents), /consent_seal_key_missing/);
  assert.equal(noKey.store.consents.length, 0);
});

test('status follows the dates and a revocation wins over expiry', () => {
  const granted = new Date('2026-10-08T15:00:00Z');
  const expiresAt = new Date(granted.getTime() + 90 * 24 * 60 * 60 * 1000);
  assert.equal(statusOf({ revokedAt: null, expiresAt }, new Date(expiresAt.getTime() - 1)), 'active');
  assert.equal(statusOf({ revokedAt: null, expiresAt }, expiresAt), 'expired');
  assert.equal(statusOf({ revokedAt: granted, expiresAt }, new Date(expiresAt.getTime() + 1)), 'revoked');
});

test('the record keeps the language the customer read and the fingerprint of that wording, and both are sealed', async () => {
  const { consents, store } = setup();
  for (const locale of ['es-CO', 'en-US'] as const) {
    const result = await grant(consents, { idempotencyKey: `key-${locale}`, body: { textVersion: 2, locale } });
    assert.ok(result.status === 'created' && result.consent.locale === locale && result.consent.wordingHash === WORDING_FINGERPRINT[locale]);
  }
  assert.notEqual(WORDING_FINGERPRINT['es-CO'], WORDING_FINGERPRINT['en-US']);
  assert.deepEqual(store.consents.map(c => c.locale), ['es-CO', 'en-US']);
  assert.equal((await consents.verify(check())).allowed, true);

  store.consents[1].wordingHash = WORDING_FINGERPRINT['es-CO'];
  store.consents[0].locale = 'en-US';
  assert.deepEqual(await consents.verify(check()), { allowed: false, reason: 'consent_invalid' });
});

test('the same key with the same data in another language is a conflict, not a replay', async () => {
  const { consents } = setup();
  assert.equal((await grant(consents)).status, 'created');
  assert.deepEqual(await grant(consents, { body: { textVersion: 2, locale: 'en-US' } }), { status: 'idempotency_conflict' });
});
