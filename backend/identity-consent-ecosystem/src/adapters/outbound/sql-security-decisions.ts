import { Client } from 'pg';
import type { SecurityDecisionStore } from '../../application/security-decisions';
import { securityDecision } from '../../domain/security-decision';
import type { SecurityDecision } from '../../domain/security-decision';

export class SqlSecurityDecisions implements SecurityDecisionStore {
  constructor(private readonly connectionString: string) {}

  async append(input: SecurityDecision): Promise<void> {
    const decision = securityDecision(input, input.decisionId, input.correlationId);
    const db = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 });
    db.on('error', () => {});
    try {
      await db.connect();
      // The implicit SQL transaction commits both records or neither. An uncertain
      // commit is never retried here: a denied request must not publish false success.
      await db.query(`WITH audit AS (
        INSERT INTO identity.audit_events
          (actor_reference, action, resource_type, resource_id, outcome, correlation_id, retention_until)
        VALUES ('unattributed', 'security.denied', 'security_decision', $1, $2, $3, now()+INTERVAL '90 days')
        RETURNING id
      )
      INSERT INTO identity.outbox_events
        (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
      SELECT $1, 'security_decision', $1, 'identity.security_denied', 1, $4, $3 FROM audit`,
      [decision.decisionId, decision.cause, decision.correlationId, JSON.stringify(decision)]);
    } finally {
      await db.end().catch(() => {});
    }
  }
}
