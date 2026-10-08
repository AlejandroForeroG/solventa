import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { CURRENT_TERMS } from '../backend/identity-consent-ecosystem/src/domain/consent';
import { SIGNAL_SCOPES } from '../backend/acquisition-risk/src/domain/signal';
import { messages } from '../apps/web/src/i18n/messages';

const read = (path: string) => readFileSync(path, 'utf8');
const consents = parse(read('packages/contracts/openapi/v1/consents.yaml'));
const common = parse(read('packages/contracts/openapi/v1/common.yaml'));
const examples = JSON.parse(read('packages/contracts/examples/consents.json'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ ...common, $id: 'https://solventa.test/v1/common.yaml' });
ajv.addSchema({ ...consents, $id: 'https://solventa.test/v1/consents.yaml' });
const schema = (name: string) => {
  const check = ajv.getSchema(`https://solventa.test/v1/consents.yaml#/components/schemas/${name}`);
  assert.ok(check, `schema ${name}`);
  return check;
};
const day = 24 * 60 * 60 * 1000;

test('every operation needs the web session and declares the failure statuses of its flow', () => {
  const operations = {
    getConsentTerms: ['200', '401', '403', '503'],
    grantConsent: ['200', '201', '400', '401', '403', '409', '503'],
    listConsents: ['200', '401', '403', '503'],
    declineConsent: ['204', '400', '401', '403', '409', '503'],
    revokeConsent: ['200', '400', '401', '403', '404', '409', '503']
  };
  const found = Object.values(consents.paths).flatMap((path) => Object.values(path as Record<string, { operationId: string; security: unknown; responses: object }>));
  assert.deepEqual(found.map(o => o.operationId).sort(), Object.keys(operations).sort());
  for (const operation of found) {
    assert.deepEqual(operation.security, [{ WebSession: [] }, { LocalWebSession: [] }]);
    for (const code of operations[operation.operationId as keyof typeof operations]) assert.ok(code in operation.responses, `${operation.operationId} lacks ${code}`);
  }
  assert.equal(consents.components.parameters.IdempotencyKey.required, true);
});

test('the examples satisfy the contract', () => {
  const checks: [string, unknown][] = [
    ['ConsentTerms', examples.terms],
    ['GrantRequest', examples.grantRequest],
    ['DeclineRequest', examples.declineRequest],
    ['ConsentError', examples.errors[0]],
    ['ConsentError', examples.errors[1]],
    ...examples.consents.map((consent: unknown): [string, unknown] => ['Consent', consent])
  ];
  for (const [name, value] of checks) {
    const check = schema(name);
    assert.ok(check(value), `${name}: ${JSON.stringify(check.errors)}`);
  }
});

test('a request cannot carry fields the contract does not define', () => {
  assert.equal(schema('GrantRequest')({ textVersion: 1, subjectToken: 'x' }), false);
  assert.equal(schema('GrantRequest')({}), false);
  assert.equal(schema('GrantRequest')({ textVersion: 1, quoteRef: 'COT-26-1' }), false);
});

test('the status of each example follows its dates, which is how the service must compute it', () => {
  const now = Date.parse(examples.asOf);
  for (const consent of examples.consents) {
    assert.equal(Date.parse(consent.expiresAt) - Date.parse(consent.grantedAt), examples.terms.validityDays * day, `${consent.consentId} lasts the validity of the terms`);
    const expected = consent.revokedAt ? 'revoked' : Date.parse(consent.expiresAt) <= now ? 'expired' : 'active';
    assert.equal(consent.status, expected, consent.consentId);
  }
  assert.deepEqual(new Set(examples.consents.map((c: { status: string }) => c.status)), new Set(['active', 'revoked', 'expired']));
});

test('a consent covers exactly the sources and scopes of its terms', () => {
  for (const consent of examples.consents) {
    assert.deepEqual(consent.sources, examples.terms.sources.map((s: { code: string }) => s.code));
    assert.deepEqual(consent.scopes, examples.terms.sources.map((s: { scope: string }) => s.scope));
  }
});

test('Identity, the contract, Acquisition and the web catalogue describe the same sources and scopes', () => {
  const codes = CURRENT_TERMS.sources.map(source => source.code);
  const scopes = CURRENT_TERMS.sources.map(source => source.scope);
  assert.deepEqual(CURRENT_TERMS.sources, examples.terms.sources);
  assert.equal(CURRENT_TERMS.textVersion, examples.terms.textVersion);
  assert.equal(CURRENT_TERMS.validityDays, examples.terms.validityDays);
  assert.deepEqual(consents.components.schemas.SourceCode.enum, codes);
  assert.deepEqual(consents.components.schemas.ScopeCode.enum, scopes);
  assert.deepEqual([...SIGNAL_SCOPES], scopes, 'Acquisition asks for exactly the scopes Identity records');
  for (const locale of ['es-CO', 'en-US'] as const) {
    for (const source of CURRENT_TERMS.sources) {
      for (const key of [`source.${source.code}.name`, `source.${source.code}.detail`, `kind.${source.kind}`, `scope.${source.scope}`]) assert.ok(messages[locale][key], `${locale} lacks ${key}`);
    }
  }
});
