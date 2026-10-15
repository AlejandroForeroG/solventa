import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const traceId = '50000000-0000-4000-8000-000000000001';

// Only owner persistence and external-provider collaborators are replaced. The real
// Identity composition root, Hono routes, use cases, publisher and email adapter run in workerd.
// This deliberately proves neither SQL transactions nor real Cloudflare email delivery.
const stateWorker = `
import { WorkerEntrypoint } from 'cloudflare:workers';
let settings = {}, rows = [], messages = [], entries = [], claims = 0, appends = 0;
async function waitForRelease(key) {
  const deadline = Date.now() + 4_000;
  while (settings[key]) {
    if (Date.now() > deadline) throw Error('test_collaborator_release_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export default class extends WorkerEntrypoint {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/configure') {
      settings = await request.json(); rows = []; messages = []; entries = []; claims = 0; appends = 0;
      return new Response('ok');
    }
    if (path === '/release-capture') { settings.blockCapture = false; return new Response('ok'); }
    if (path === '/release-mail') { settings.blockMail = false; return new Response('ok'); }
    return Response.json({ rows, messages, entries, claims, appends });
  }
  async append(decision) {
    appends++; entries.push('capture_started');
    if (settings.failAppend) throw Error('test_capture_unavailable');
    await waitForRelease('blockCapture');
    rows.push({ eventId: decision.decisionId, eventType: 'identity.security_denied', eventVersion: 1,
      aggregateType: 'security_decision', aggregateId: decision.decisionId, correlationId: decision.correlationId,
      payload: decision, attempts: 0, createdAt: Date.now(), status: 'pending' });
    entries.push('capture_committed');
  }
  async claim(input) {
    claims++; entries.push('claim');
    if (settings.failClaim) throw Error('test_claim_unavailable');
    const batch = rows.filter(row => row.status === 'pending').slice(0, input.limit);
    for (const row of batch) { row.status = 'publishing'; row.attempts++; row.leaseOwner = input.leaseOwner; row.leaseUntil = Date.now() + input.leaseMs; }
    return { events: batch.map(row => ({ ...row })), deadLettered: 0 };
  }
  async published(id, owner) {
    const row = rows.find(row => row.eventId === id && row.leaseOwner === owner);
    if (!row) return false;
    row.status = 'published'; entries.push('published'); return true;
  }
  async failed(id, owner, delay) {
    const row = rows.find(row => row.eventId === id && row.leaseOwner === owner);
    if (!row) return false;
    row.status = delay === null ? 'dead_letter' : 'pending'; entries.push('delivery_failed'); return true;
  }
  async send(message) {
    messages.push(message); entries.push('send_started');
    await waitForRelease('blockMail');
    entries.push('provider_ack'); return { messageId: 'synthetic-provider-ack' };
  }
}`;

const aliases = {
  'sql-security-decisions': `import { env } from 'cloudflare:workers'; export class SqlSecurityDecisions { async append(value) { await env.TEST_STATE.append(value); } }`,
  'security-alert-outbox': `import { env } from 'cloudflare:workers'; export class SqlSecurityAlertOutbox {
    async claim(input) { return env.TEST_STATE.claim(input); }
    async published(id, owner) { return env.TEST_STATE.published(id, owner); }
    async failed(id, owner, delay) { return env.TEST_STATE.failed(id, owner, delay); }
  }`,
  'sql-consents': `export class SqlConsents { async forSubject() { return []; } }`,
  'identity-sessions': `export class SqlIdentitySessions { async find() { return null; } }`,
  'partner-access': `export class SqlPartnerAccess { async find() { return null; } }`,
  'registered-devices': `export class SqlRegisteredDevices { async execute() { throw Error('unexpected_device_access'); } }`,
  'database-probe': `export async function databaseProbe() { throw Error('unexpected_database_probe'); }`,
  'workos-authentication': `export class WorkosAuthentication { async authenticate() { throw Error('unexpected_provider_access'); } }`,
  'workos-partner-authentication': `export class WorkosPartnerAuthentication { async authenticate() { throw Error('unexpected_provider_access'); } }`,
  'workos-mobile-authentication': `export class WorkosMobileAuthentication { async authenticate() { throw Error('unexpected_provider_access'); } }`,
};
const rpcCaller = `export default { async fetch(request, env) {
  const method = new URL(request.url).pathname;
  const result = method === '/consent'
    ? await env.IDENTITY.verifyConsentV1({ subjectToken: '40000000-0000-4000-8000-000000000001', purposeCode: 'risk_profiling', scope: 'payment_history_score', traceId: '${traceId}' })
    : await env.IDENTITY.authorizeApiAccessV1({ kind: 'partner', token: '', operation: 'quotes:create', traceId: '${traceId}' });
  return Response.json(result);
} };`;

async function until(state, predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const snapshot = await (await state.fetch('http://state/snapshot')).json();
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Composition did not reach the expected observable state');
}

test('workerd executes real Identity security composition with explicit local SQL/provider collaborators', { timeout: 30_000 }, async t => {
  const config = JSON.parse(await readFile('backend/identity-consent-ecosystem/wrangler.jsonc', 'utf8'));
  const bundle = await build({
    entryPoints: ['backend/identity-consent-ecosystem/src/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['cloudflare:*', 'node:*'],
    plugins: [{ name: 'explicit-local-owner-and-provider-collaborators', setup(builder) {
      builder.onResolve({ filter: /outbound\/(sql-security-decisions|security-alert-outbox|sql-consents|identity-sessions|partner-access|registered-devices|database-probe|workos-authentication|workos-partner-authentication|workos-mobile-authentication)$/ }, args => (
        { path: args.path.split('/').at(-1), namespace: 'composition-collaborator' }
      ));
      builder.onLoad({ filter: /.*/, namespace: 'composition-collaborator' }, args => ({ contents: aliases[args.path], loader: 'js' }));
    } }],
  });
  const email = { environment: 'local', from: 'security@example.invalid', to: 'operator@example.invalid' };
  const worker = (name, emailConfig) => ({
    name, unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    bindings: { APP_ENV: 'local', IDENTITY_DB: { connectionString: 'postgresql://synthetic.invalid/unused' },
      ...(emailConfig === undefined ? {} : { SECURITY_ALERT_EMAIL_CONFIG: JSON.stringify(emailConfig) }) },
    serviceBindings: { TEST_STATE: 'state', SECURITY_EMAIL: 'state' },
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
    worker('enabled', email), worker('disabled'), worker('invalid', { ...email, environment: 'prod' }),
    { name: 'state', modules: true, script: stateWorker, compatibilityDate: config.compatibility_date },
    { name: 'caller', unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }], modules: true, script: rpcCaller,
      compatibilityDate: config.compatibility_date, serviceBindings: { IDENTITY: 'enabled' } },
  ] }));
  t.after(() => runtime.dispose());
  await runtime.ready;
  const state = await runtime.getWorker('state');
  const enabled = await runtime.getWorker('enabled');
  const invalid = await runtime.getWorker('invalid');
  const enabledUrl = await runtime.unsafeGetDirectURL('enabled');
  const disabledUrl = await runtime.unsafeGetDirectURL('disabled');
  const callerUrl = await runtime.unsafeGetDirectURL('caller');
  const configure = async settings => { await state.fetch('http://state/configure', { method: 'POST', body: JSON.stringify(settings) }); };
  const release = async path => { await state.fetch('http://state/' + path); };
  const request = base => fetch(new URL('/api/v1/access/partner', base), {
    headers: { 'X-Trace-Id': traceId, 'X-Synthetic-Private': 'synthetic-private-marker' }, signal: AbortSignal.timeout(5_000),
  });

  await t.test('a configured email binding alone cannot claim or send without the optional email configuration', async () => {
    await configure({});
    assert.equal((await request(disabledUrl)).status, 401);
    const snapshot = await until(state, current => current.rows.length === 1);
    assert.equal(snapshot.claims, 0);
    assert.deepEqual(snapshot.messages, []);
    await (await runtime.getWorker('disabled')).scheduled({ cron: '* * * * *' });
    assert.equal((await until(state, current => current.rows.length === 1)).claims, 0);
  });

  await t.test('capture commits before the denial responds and waitUntil publishes only after provider ACK', async () => {
    await configure({ blockCapture: true, blockMail: true });
    let responded = false;
    const pending = request(enabledUrl).then(response => { responded = true; return response; });
    const capturing = await until(state, current => current.appends === 1);
    assert.equal(responded, false);
    assert.equal(capturing.claims, 0);
    assert.deepEqual(capturing.messages, []);
    await release('release-capture');
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-trace-id'), traceId);
    const sending = await until(state, current => current.messages.length === 1);
    assert.equal(sending.rows[0].status, 'publishing');
    assert.equal(sending.entries.includes('published'), false);
    assert.equal(JSON.stringify(sending.rows).includes('synthetic-private-marker'), false);
    assert.equal(JSON.stringify(sending.messages).includes('synthetic-private-marker'), false);
    await release('release-mail');
    const complete = await until(state, current => current.rows[0]?.status === 'published');
    assert.ok(complete.entries.indexOf('capture_committed') < complete.entries.indexOf('claim'));
    assert.ok(complete.entries.indexOf('provider_ack') < complete.entries.indexOf('published'));
  });

  await t.test('failed capture returns 503 without a false durable denial, claim or email', async () => {
    await configure({ failAppend: true });
    const response = await request(enabledUrl);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'access_unavailable', traceId });
    const snapshot = await until(state, current => current.appends === 1);
    assert.deepEqual(snapshot.rows, []);
    assert.equal(snapshot.claims, 0);
    assert.deepEqual(snapshot.messages, []);
  });

  await t.test('invalid email configuration fails the actual scheduled invocation before claiming', async () => {
    await configure({});
    const result = await invalid.scheduled({ cron: '* * * * *' });
    assert.equal(result.outcome, 'exception');
    assert.equal((await until(state, current => current.claims === 0)).claims, 0);
  });

  await t.test('dispatch persistence failure is visible to cron while the HTTP denial stays 401', async () => {
    await configure({ failClaim: true });
    assert.equal((await request(enabledUrl)).status, 401);
    const failed = await until(state, current => current.claims === 1);
    assert.equal(failed.rows[0].status, 'pending');
    assert.deepEqual(failed.messages, []);
    const result = await enabled.scheduled({ cron: '* * * * *' });
    assert.equal(result.outcome, 'exception');
  });

  await t.test('real access and consent RPC entrypoints schedule the same captured-event publisher', async () => {
    for (const path of ['/access', '/consent']) {
      await configure({});
      const response = await fetch(new URL(path, callerUrl));
      assert.equal((await response.json()).allowed, false);
      const snapshot = await until(state, current => current.rows[0]?.status === 'published');
      assert.equal(snapshot.rows[0].correlationId, traceId);
      assert.equal(snapshot.rows[0].payload.category, path === '/access' ? 'api_access' : 'consent_use');
      assert.equal(snapshot.messages.length, 1);
      assert.ok(snapshot.entries.indexOf('capture_committed') < snapshot.entries.indexOf('claim'));
    }
  });
});
