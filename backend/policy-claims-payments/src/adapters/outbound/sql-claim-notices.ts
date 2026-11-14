import type { Client } from 'pg';
import type { ClaimNotice } from '../../domain/claim-review';

export async function addClaimNotices(db: Client, eventId: string, claimId: string, action: ClaimNotice, customer: string, analyst: string, expert?: string) {
  await db.query(`INSERT INTO policy.claim_notices (event_id, claim_id, audience, recipient, action)
    SELECT $1, $2, audience, recipient, $3
    FROM (VALUES ('customer', $4::STRING), ('analyst', $5::STRING), ('expert', $6::STRING)) AS recipients(audience, recipient)
    WHERE recipient IS NOT NULL`, [eventId, claimId, action, customer, analyst, expert ?? null]);
}
