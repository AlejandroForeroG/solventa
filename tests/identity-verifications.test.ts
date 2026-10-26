import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { IdentityVerifications } from '../backend/identity-consent-ecosystem/src/application/identity-verifications';
import { canonicalVerificationContent, VerificationFailure, verificationValidityMs } from '../backend/identity-consent-ecosystem/src/domain/identity-verification';
import type { VerificationView } from '../backend/identity-consent-ecosystem/src/domain/identity-verification';
import { syntheticKycSource } from '../backend/identity-consent-ecosystem/src/adapters/outbound/synthetic-identity-verification';
import { verificationIdentity, verificationOther, verificationSetup } from './support/identity-verification-fakes';

const failure = (code: string) => (error: unknown) => error instanceof VerificationFailure && error.code === code;
async function ready(setup: ReturnType<typeof verificationSetup>, document = 'document-readable', selfie = 'selfie-matched', liveness = 'liveness-passed') {
  let view = await setup.application.grant(setup.context(), { textVersion: 1, locale: 'es-CO' });
  for (const [step, reference] of [['document', document], ['selfie', selfie], ['liveness', liveness]] as const) {
    view = await setup.application.saveStep(setup.context(view.id), step, setup.fixture(reference), view.version);
  }
  return view;
}

test('grant is explicit, purpose-specific, owner-scoped and valid for exactly 24 hours', async () => {
  const r = verificationSetup();
  await assert.rejects(r.application.grant(r.context(), { textVersion: 0, locale: 'es-CO' }), failure('terms_outdated'));
  assert.equal(r.store.rows.size, 0);
  const ctx = r.context();
  const view = await r.application.grant(ctx, { textVersion: 1, locale: 'es-CO' });
  assert.equal(Date.parse(view.expiresAt) - Date.parse(view.createdAt), verificationValidityMs);
  assert.equal(view.consent.purpose, 'identity_verification');
  assert.equal(view.consent.status, 'active');
  assert.equal(view.status, 'draft');
  assert.equal(r.calls, 0);
  assert.deepEqual(await r.application.grant(ctx, { textVersion: 1, locale: 'es-CO' }), view);
  await assert.rejects(r.application.grant(ctx, { textVersion: 1, locale: 'en-US' }), failure('conflict'));
  assert.equal(r.store.events.length, 1);
  await assert.rejects(r.application.grant(r.context(), { textVersion: 1, locale: 'es-CO' }), failure('conflict'));
});

test('simultaneous identical grants commit one logical case and consent event', async () => {
  const r = verificationSetup();
  const ctx = r.context();
  const views = await Promise.all([r.application.grant(ctx, { textVersion: 1, locale: 'es-CO' }), r.application.grant(ctx, { textVersion: 1, locale: 'es-CO' })]);
  assert.deepEqual(views[0], views[1]);
  assert.equal(r.store.rows.size, 1);
  assert.equal(r.store.events.length, 1);
});

test('no case or incomplete evidence reaches the provider', async () => {
  const r = verificationSetup();
  await assert.rejects(r.application.evaluate(r.context(randomUUID()), 1), failure('not_found'));
  const view = await r.application.grant(r.context(), { textVersion: 1, locale: 'en-US' });
  await assert.rejects(r.application.evaluate(r.context(view.id), view.version), failure('steps_incomplete'));
  await assert.rejects(r.application.requestAssistance(r.context(view.id), view.version), failure('assistance_unavailable'));
  assert.equal(r.calls, 0);
});

test('fixture hashes, step binding and corpus versions are enforced on the server', async () => {
  const r = verificationSetup();
  const view = await r.application.grant(r.context(), { textVersion: 1, locale: 'es-CO' });
  for (const evidence of [r.fixture('selfie-matched'), { ...r.fixture('document-readable'), sha256: '0'.repeat(64) },
    { ...r.fixture('document-readable'), corpusVersion: 'another-version' }]) {
    await assert.rejects(r.application.saveStep(r.context(view.id), 'document', evidence, view.version), failure('evidence_invalid'));
  }
  assert.deepEqual((await r.application.inspect(verificationIdentity, randomUUID()))?.steps, []);
  assert.equal(r.calls, 0);
});

test('successful evaluation persists simulation and capture while changing no session or business grant', async () => {
  const r = verificationSetup();
  const owner = structuredClone(r.store.users.get(verificationIdentity.providerSubject));
  const view = await ready(r);
  const evaluated = await r.application.evaluate(r.context(view.id), view.version);
  assert.equal(evaluated.status, 'approved');
  assert.equal(evaluated.result?.simulated, true);
  assert.equal(evaluated.retryAllowed, false);
  assert.deepEqual(r.store.users.get(verificationIdentity.providerSubject), owner);
  const capture = r.store.events.find(event => event.action === 'evaluated')!.capture;
  const validate = new Ajv({ strict: false }).compile(JSON.parse(readFileSync('packages/contracts/schemas/decision-capture.v1.json', 'utf8')));
  assert.equal(validate(capture), true, JSON.stringify(validate.errors));
  assert.equal(capture.consent.status, 'verified');
  assert.deepEqual(capture.sources.map(source => source.source), ['synthetic-kyc.v1']);
  assert.equal(r.calls, 1);
  await assert.rejects(r.application.saveStep(r.context(view.id), 'document', r.fixture('document-readable'), evaluated.version), failure('conflict'));
});

test('a failed step is retried alone after restoring the saved progress', async () => {
  const r = verificationSetup();
  const view = await ready(r, 'document-unreadable');
  let failed = await r.application.evaluate(r.context(view.id), view.version);
  assert.equal(failed.status, 'not_verified');
  assert.deepEqual(failed.steps.map(step => step.step), ['selfie', 'liveness']);
  const resumed = new IdentityVerifications(r.deps);
  assert.deepEqual(await resumed.inspect(verificationIdentity, randomUUID()), failed);
  failed = await resumed.saveStep(r.context(view.id), 'document', r.fixture('document-readable'), failed.version);
  assert.equal((await resumed.evaluate(r.context(view.id), failed.version)).status, 'approved');
});

test('review and simulated screening matches never grant an approval', async () => {
  for (const [selfie, liveness] of [['selfie-review', 'liveness-passed'], ['selfie-matched', 'liveness-screening-match']]) {
    const r = verificationSetup();
    const view = await ready(r, 'document-readable', selfie, liveness);
    const result = await r.application.evaluate(r.context(view.id), view.version);
    assert.equal(result.status, 'review');
    const assisted = await r.application.requestAssistance(r.context(view.id), result.version);
    assert.equal(assisted.assistance?.status, 'pending');
  }
});

test('technical failures retain all steps, allow more than three manual retries and optional assistance from the first failure', async () => {
  const r = verificationSetup();
  let view = await ready(r, 'document-technical');
  view = await r.application.evaluate(r.context(view.id), view.version);
  assert.equal(view.status, 'unavailable');
  assert.equal(view.result, null);
  assert.equal(view.steps.length, 3);
  view = await r.application.requestAssistance(r.context(view.id), view.version);
  const reference = view.assistance?.reference;
  for (let attempt = 0; attempt < 4; attempt++) {
    view = await r.application.evaluate(r.context(view.id), view.version);
    assert.equal(view.status, 'unavailable');
    assert.equal(view.steps.length, 3);
    assert.equal(view.assistance?.reference, reference);
  }
  const requests = await Promise.all([r.application.requestAssistance(r.context(view.id), view.version), r.application.requestAssistance(r.context(view.id), view.version)]);
  assert.ok(requests.every(result => result.assistance?.reference === reference));
  assert.equal(r.store.events.filter(event => event.action === 'assistance_requested').length, 1);
});

test('concurrent retries of an evaluation create one final decision', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const r = verificationSetup(async (input, signal) => { began(); await pending; return syntheticKycSource(input, signal); });
  const view = await ready(r);
  const ctx = r.context(view.id);
  const first = r.application.evaluate(ctx, view.version);
  await started;
  const retry = r.application.evaluate(ctx, view.version);
  release();
  const results = await Promise.all([first, retry]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, 'approved');
  assert.equal(r.store.events.filter(event => event.action === 'evaluated').length, 1);
  assert.equal(r.store.events.filter(event => event.action === 'evaluation_requested').length, 1);
  await assert.rejects(r.application.evaluate(ctx, view.version + 1), failure('conflict'));
});

test('revocation during the provider call discards the late result and reusable progress', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const r = verificationSetup(async (input, signal) => { began(); await pending; return syntheticKycSource(input, signal); });
  const view = await ready(r);
  const evaluation = r.application.evaluate(r.context(view.id), view.version);
  const rejected = assert.rejects(evaluation, failure('consent_inactive'));
  await started;
  const revoked = await r.application.revoke(r.context(view.id));
  release();
  await rejected;
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(revoked.steps, []);
  assert.equal(r.store.events.filter(event => event.action === 'evaluated').length, 0);
});

test('expiry during evaluation blocks use and a new consent starts with no reused progress', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const r = verificationSetup(async (input, signal) => { began(); await pending; return syntheticKycSource(input, signal); });
  const view = await ready(r);
  const evaluation = r.application.evaluate(r.context(view.id), view.version);
  const rejected = assert.rejects(evaluation, failure('consent_inactive'));
  await started;
  r.store.now = view.expiresAt;
  release();
  await rejected;
  const expired = await r.application.inspect(verificationIdentity, randomUUID());
  assert.equal(expired?.status, 'expired');
  assert.deepEqual(expired?.steps, []);
  const renewed = await r.application.grant(r.context(), { textVersion: 1, locale: 'es-CO' });
  assert.notEqual(renewed.id, view.id);
  assert.notEqual(renewed.consent.id, view.consent.id);
  assert.deepEqual(renewed.steps, []);
});

test('revoked or foreign sessions and foreign cases disclose no owner state and invoke no provider', async () => {
  const r = verificationSetup();
  const view = await ready(r);
  const foreign = { ...r.context(view.id), identity: verificationOther };
  await assert.rejects(r.application.evaluate(foreign, view.version), failure('not_found'));
  assert.equal(await r.application.inspect(verificationOther, randomUUID()), null);
  r.store.denied = true;
  await assert.rejects(r.application.evaluate(r.context(view.id), view.version), failure('unauthorized'));
  assert.equal(r.calls, 0);
});

test('failed commit returns no successful grant and leaves no partial state, command or audit', async () => {
  const r = verificationSetup();
  r.store.failNextCommit = true;
  const ctx = r.context();
  await assert.rejects(r.application.grant(ctx, { textVersion: 1, locale: 'es-CO' }), /synthetic_commit_failed/);
  assert.equal(r.store.rows.size, 0);
  assert.equal(r.store.commands.size, 0);
  assert.equal(r.store.events.length, 0);
  assert.equal((await r.application.grant(ctx, { textVersion: 1, locale: 'es-CO' })).status, 'draft');
});

test('a lost final commit is recovered through the same evaluation reference', async () => {
  let fail = true;
  const references: string[] = [];
  const r = verificationSetup(async (input, signal) => {
    references.push(input.evaluationId);
    if (fail) { fail = false; r.store.failNextCommit = true; }
    return syntheticKycSource(input, signal);
  });
  const view = await ready(r);
  const ctx = r.context(view.id);
  await assert.rejects(r.application.evaluate(ctx, view.version), /synthetic_commit_failed/);
  const pendingId = r.store.rows.get(view.id)!.state.pending!.evaluationId;
  assert.equal((await r.application.evaluate(ctx, view.version)).status, 'approved');
  assert.deepEqual(references, [pendingId, pendingId]);
  assert.equal(r.store.events.filter(event => event.action === 'evaluated').length, 1);
});

test('each fixture is an actual synthetic PNG matching its published hash', () => {
  const r = verificationSetup();
  for (const item of r.application.fixtures()) {
    const bytes = readFileSync('packages/contracts/' + item.assetPath);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  }
});

test('canonical sealing survives JSONB key ordering and does not accept non-JSON state', () => {
  assert.equal(canonicalVerificationContent({ b: 1, a: { z: true, x: null } }), canonicalVerificationContent({ a: { x: null, z: true }, b: 1 }));
  assert.throws(() => canonicalVerificationContent({ invalid: Infinity }), /invalid_verification_state/);
});
