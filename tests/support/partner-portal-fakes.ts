import { Hono } from 'hono';
import { mountPartnerPortal } from '../../backend/acquisition-risk/src/adapters/inbound/partner-portal-http';
import { PartnerPortal } from '../../backend/acquisition-risk/src/application/partner-portal';
import modernExample from '../../packages/contracts/examples/partner-portal-v2.json';
import example from '../../packages/contracts/examples/partner-portal.json';

export const portalExample = example;
export function portalActor(modern = false) {
  const expiresAt = new Date(Date.now() + 5000).toISOString();
  return { kind: 'user', channel: 'web', principal: { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, operations: ['partner-portal:read'], authorizationExpiresAt: expiresAt,
    partnerPortal: { ...(modern ? { quota: { ...modernExample.quota, windowStart: new Date().toISOString().slice(0,10)+'T00:00:00.000Z', resetsAt: new Date(Date.parse(new Date().toISOString().slice(0,10))+86400000).toISOString(), updatedAt: new Date().toISOString() } } : {}), expiresAt, partnerId: example.partner.id, code: example.partner.code, credentials: example.credentials, hasMoreCredentials: false } };
}
export function portalApp(mode: 'ready' | 'empty' | 'denied' | 'unavailable' = 'ready', modern = false) {
  const app = new Hono<{ Bindings: AcquisitionEnv }>();
  const { updatedAt, totals, items, hasMore } = example;
  mountPartnerPortal(app, { authorize: async () => mode === 'denied' ? { allowed: false, error: 'forbidden', status: 403 } : { allowed: true, actor: portalActor(modern) },
    portal: new PartnerPortal({ read: async () => {
      if (mode === 'unavailable') throw new Error('synthetic_store_failure');
      return mode === 'empty' ? { updatedAt, totals: { completed: 0, accepted: 0, preliminary: 0, declined: 0 }, items: [], hasMore: false }
        : { updatedAt, totals, items: items.map(i => ({ ...i, kind: i.kind === 'quote' ? 'quote' : 'offer_decision', result: i.result === 'completed' ? 'completed' : 'accepted' })), hasMore };
    } }), versions: example.versions });
  return app;
}
