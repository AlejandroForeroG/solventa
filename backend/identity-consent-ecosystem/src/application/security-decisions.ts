import { canonicalSecurityId, securityDecision } from '../domain/security-decision';
import type { SecurityDecision, SecurityDenial } from '../domain/security-decision';

export interface SecurityDecisionStore {
  append(decision: SecurityDecision): Promise<void>;
}

export class SecurityDecisions {
  constructor(private readonly store: SecurityDecisionStore, private readonly newId: () => string) {}

  async deny(input: SecurityDenial, traceId?: unknown): Promise<void> {
    const decisionId = this.newId();
    const correlationId = canonicalSecurityId(traceId) ?? decisionId;
    await this.store.append(securityDecision(input, decisionId, correlationId));
  }
}
