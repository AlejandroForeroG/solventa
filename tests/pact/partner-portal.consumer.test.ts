import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { readPartnerPortal } from '../../apps/web/src/partner-portal/api';
import example from '../../packages/contracts/examples/partner-portal.json';
import { assertMatchesCommitted, pactOutputDir, providerName } from './support/pact-files';

const consumer = 'solventa-partner-web';
const dir = pactOutputDir();
const pact = new PactV3({ consumer, provider: providerName, dir, logLevel: 'error' });
after(() => assertMatchesCommitted(dir, `${consumer}-${providerName}.json`));
for (const mode of ['ready','empty','denied','unavailable'] as const) {
  test(`partner web consults an explicitly granted integration: ${mode}`, async () => {
    const status = mode === 'denied' ? 403 : mode === 'unavailable' ? 503 : 200;
    const body = status === 200 ? { ...example, ...(mode === 'empty' ? { items: [], totals: { completed: 0, accepted: 0, preliminary: 0, declined: 0 } } : {}), traceId: MatchersV3.uuid(example.traceId) }
      : { error: mode === 'denied' ? 'forbidden' : 'portal_unavailable', traceId: MatchersV3.uuid(example.traceId) };
    pact.given(`partner portal ${mode}`).uponReceiving(`a partner portal read with ${mode} data`)
      .withRequest({ method: 'GET', path: '/api/v1/partner-portal', query: { from: '2026-11-01', to: '2026-11-07' } })
      .willRespondWith({ status, headers: { 'Content-Type': 'application/json' }, body });
    await pact.executeTest(async server => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? server.url + input : input, init);
      try {
        const result = await readPartnerPortal('2026-11-01', '2026-11-07', new AbortController().signal);
        assert.equal(result.kind, status === 200 ? 'ok' : mode === 'denied' ? 'forbidden' : 'unavailable');
      } finally { globalThis.fetch = realFetch; }
    });
  });
}
