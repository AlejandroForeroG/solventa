import { randomUUID } from 'node:crypto';
import type { PartnerAuthorizationStore } from '../../backend/identity-consent-ecosystem/src/application/ports/partner-authorizations';
import { PARTNER_OFFER_OPERATION, type PartnerAuthorization } from '../../backend/identity-consent-ecosystem/src/domain/partner-authorization';

export class MemoryPartnerAuthorizations implements PartnerAuthorizationStore {
  rows: (PartnerAuthorization & { partnerId: string; clientId: string; subjectToken: string })[] = [];
  events: string[] = [];
  constructor(private readonly partners: ReadonlyMap<string, string>, private readonly now: () => Date) {}
  async grant(input: Parameters<PartnerAuthorizationStore['grant']>[0]) {
    const id = this.partners.get(input.partnerCode);
    if (!id) return null;
    const row = { id: randomUUID(), partnerCode: input.partnerCode, operation: PARTNER_OFFER_OPERATION, grantedAt: input.grantedAt, expiresAt: input.expiresAt, revokedAt: null,
      partnerId: id, clientId: input.principal.clientId, subjectToken: input.principal.subjectToken };
    this.rows.push(row); this.events.push('granted');
    return row;
  }
  async list(principal: { clientId: string }, limit: number) { return this.rows.filter(row => row.clientId === principal.clientId).slice(0, limit).reverse(); }
  async revoke(principal: { clientId: string }, id: string, now: Date) {
    const row = this.rows.find(candidate => candidate.id === id && candidate.clientId === principal.clientId);
    if (!row) return { kind: 'not_found' as const };
    if (row.revokedAt) return { kind: 'already_revoked' as const, authorization: row };
    if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' as const, authorization: row };
    row.revokedAt = now; this.events.push('revoked');
    return { kind: 'revoked' as const, authorization: row };
  }
  async find(forPartner: string, id: string) {
    const row = this.rows.find(candidate => candidate.id === id && candidate.partnerId === forPartner);
    return row && !row.revokedAt && row.expiresAt.getTime() > this.now().getTime() ? { clientId: row.clientId, subjectToken: row.subjectToken, expiresAt: row.expiresAt.toISOString() } : null;
  }
}
