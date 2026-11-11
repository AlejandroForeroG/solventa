import { Hono } from 'hono';
import { mountPartnerPortal } from '../../backend/acquisition-risk/src/adapters/inbound/partner-portal-http';
import { PartnerPortal } from '../../backend/acquisition-risk/src/application/partner-portal';
import example from '../../packages/contracts/examples/partner-portal.json';

export const portalExample = example;
export function portalActor() {
  const expiresAt = new Date(Date.now() + 5000).toISOString();
  return { kind: 'user', channel: 'web', principal: { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, operations: ['partner-portal:read'], authorizationExpiresAt: expiresAt,
    partnerPortal: { expiresAt, partnerId: example.partner.id, code: example.partner.code, credentials: example.credentials, hasMoreCredentials: false } };
}
export function portalApp(mode: 'ready' | 'empty' | 'denied' | 'unavailable' = 'ready') {
  const app = new Hono<{ Bindings: AcquisitionEnv }>();
  const { updatedAt, totals, items, hasMore } = example;
  mountPartnerPortal(app, { authorize: async () => mode === 'denied' ? { allowed: false, error: 'forbidden', status: 403 } : { allowed: true, actor: portalActor() },
    portal: new PartnerPortal({ read: async () => {
      if (mode === 'unavailable') throw new Error('synthetic_store_failure');
      return mode === 'empty' ? { updatedAt, totals: { completed: 0, accepted: 0, preliminary: 0, declined: 0 }, items: [], hasMore: false }
        : { updatedAt, totals, items: items.map(i => ({ ...i, kind: i.kind === 'quote' ? 'quote' : 'offer_decision', result: i.result === 'completed' ? 'completed' : 'accepted' })), hasMore };
    } }), versions: example.versions });
  return app;
}
