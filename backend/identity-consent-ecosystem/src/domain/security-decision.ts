export const securityChannels = ['partner', 'web', 'mobile', 'internal'] as const;
export const securityOperations = ['quotes:create', 'consents:read', 'consents:write', 'web:session', 'mobile:session', 'mobile:devices', 'consent:use',
  'offers:create', 'offers:create-flight', 'offers:read', 'offers:accept', 'policies:read', 'policies:issue', 'identity-verifications:read', 'identity-verifications:write'] as const;
export const securityCauses = ['unauthorized', 'forbidden', 'consent_missing', 'consent_revoked', 'consent_expired', 'consent_invalid', 'consent_request_invalid'] as const;

export type SecurityDenial = {
  category: 'api_access' | 'consent_use';
  channel: typeof securityChannels[number];
  operation: typeof securityOperations[number];
  cause: typeof securityCauses[number];
};
export type SecurityDecision = SecurityDenial & { schemaVersion: 1; decisionId: string; correlationId: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function canonicalSecurityId(value: unknown): string | null {
  return typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null;
}

export function securityDecision(input: SecurityDenial, decisionId: string, correlationId: string): SecurityDecision {
  const id = canonicalSecurityId(decisionId);
  const trace = canonicalSecurityId(correlationId);
  if (!id || !trace || !securityChannels.includes(input.channel) || !securityOperations.includes(input.operation)
    || !securityCauses.includes(input.cause)) throw new Error('invalid_security_decision');
  const consent = input.category === 'consent_use';
  if (consent ? input.channel !== 'internal' || input.operation !== 'consent:use' || !input.cause.startsWith('consent_')
    : input.category !== 'api_access' || input.channel === 'internal' || input.operation === 'consent:use'
      || !['unauthorized', 'forbidden'].includes(input.cause)) throw new Error('invalid_security_decision');
  // Reconstruct the fixed shape: never spread caller objects into security telemetry.
  return { schemaVersion: 1, decisionId: id, correlationId: trace,
    category: input.category, channel: input.channel, operation: input.operation, cause: input.cause };
}
