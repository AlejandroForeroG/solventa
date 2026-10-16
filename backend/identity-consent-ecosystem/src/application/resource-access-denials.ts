import { canonicalSecurityId } from '../domain/security-decision';
import type { SecurityDecisions } from './security-decisions';

const operations = ['offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue'] as const;
type Operation = typeof operations[number];
const member = (value: unknown): value is Operation => typeof value === 'string' && operations.some(operation => operation === value);
export type ResourceDenialResult = { recorded: true } | { recorded: false; error: 'invalid_request' | 'access_unavailable' };

// The private RPC accepts no resource, actor or credential identifiers. Foreign and absent resources
// retain the same public response and the same fixed telemetry shape, preventing an ownership oracle.
export async function denyResourceAccess(security: Pick<SecurityDecisions, 'deny'>, input: unknown): Promise<ResourceDenialResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || !('operation' in input) || !member(input.operation) || !('traceId' in input)) return { recorded: false, error: 'invalid_request' };
  const traceId = canonicalSecurityId(input.traceId);
  if (!traceId) return { recorded: false, error: 'invalid_request' };
  try {
    await security.deny({ category: 'api_access', channel: 'web', operation: input.operation, cause: 'forbidden' }, traceId);
    return { recorded: true };
  } catch { return { recorded: false, error: 'access_unavailable' }; }
}
