import { randomUUID } from 'node:crypto';
import type { AdvisorSaleAuthorizationStore } from '../../backend/identity-consent-ecosystem/src/application/ports/advisor-sale-authorizations';
import { ADVISOR_SALE_OPERATION, MAX_ACTIVE_AUTHORIZATIONS, type AdvisorSaleAuthorization } from '../../backend/identity-consent-ecosystem/src/domain/advisor-sale-authorization';

export class MemoryAdvisorSaleAuthorizations implements AdvisorSaleAuthorizationStore {
  rows: (AdvisorSaleAuthorization & { clientId: string; subjectToken: string })[] = [];
  events: string[] = [];
  // advisor reference -> the advisor's own client id
  constructor(private readonly advisors: ReadonlyMap<string, string>, private readonly now: () => Date, private readonly newId: () => string = randomUUID) {}
  async grant(input: Parameters<AdvisorSaleAuthorizationStore['grant']>[0]) {
    const advisorClient = this.advisors.get(input.advisorReference);
    if (!advisorClient || advisorClient === input.principal.clientId) return null;
    const active = this.rows.filter(row => row.clientId === input.principal.clientId && !row.revokedAt && row.expiresAt.getTime() > this.now().getTime()).length;
    if (active >= MAX_ACTIVE_AUTHORIZATIONS) return 'limit_reached' as const;
    const row = { id: this.newId(), advisorReference: input.advisorReference, operation: ADVISOR_SALE_OPERATION, grantedAt: input.grantedAt, expiresAt: input.expiresAt,
      revokedAt: null, clientId: input.principal.clientId, subjectToken: input.principal.subjectToken };
    this.rows.push(row); this.events.push('granted');
    return row;
  }
  async list(principal: { clientId: string }, limit: number) {
    const live = (row: { revokedAt: Date | null; expiresAt: Date }) => !row.revokedAt && row.expiresAt.getTime() > this.now().getTime();
    return this.rows.filter(row => row.clientId === principal.clientId).reverse().sort((a, b) => Number(live(b)) - Number(live(a))).slice(0, limit);
  }
  async revoke(principal: { clientId: string }, id: string, now: Date) {
    const row = this.rows.find(candidate => candidate.id === id && candidate.clientId === principal.clientId);
    if (!row) return { kind: 'not_found' as const };
    if (row.revokedAt) return { kind: 'already_revoked' as const, authorization: row };
    if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' as const, authorization: row };
    row.revokedAt = now; this.events.push('revoked');
    return { kind: 'revoked' as const, authorization: row };
  }
  async find(advisorReference: string, id: string) {
    const row = this.rows.find(candidate => candidate.id === id && candidate.advisorReference === advisorReference);
    return row && !row.revokedAt && row.expiresAt.getTime() > this.now().getTime() ? { clientId: row.clientId, subjectToken: row.subjectToken, expiresAt: row.expiresAt.toISOString() } : null;
  }
}
