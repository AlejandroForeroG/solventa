export type PortalQuery = { from: string; to: string };
export type PortalTransaction = { id: string; reference: string; kind: 'quote' | 'offer_decision'; occurredAt: string; result: 'completed' | 'accepted' | 'preliminary' | 'declined'; ruleVersion: string };
export type PortalActivity = { updatedAt: string; totals: { completed: number; accepted: number; preliminary: number; declined: number }; items: PortalTransaction[]; hasMore: boolean };
export interface PartnerPortalStore { read(partnerId: string, query: PortalQuery): Promise<PortalActivity>; }

export class PartnerPortal {
  constructor(private readonly store: PartnerPortalStore, private readonly now: () => number = Date.now) {}
  async read(partnerId: string, query: PortalQuery, expiresAt: string) {
    if (!(Date.parse(expiresAt) > this.now())) throw new Error('access_expired');
    const result = await this.store.read(partnerId, query);
    if (!(Date.parse(expiresAt) > this.now())) throw new Error('access_expired');
    return result;
  }
}
