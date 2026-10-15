import type { AccessCredential, AccessDecision, ApiAccess, QuoteActor } from '../../application/ports/api-access';
import { canonicalTraceId } from '../trace-id';

// The Service Binding to Identity (`authorizeApiAccessV1`). Its reply is untrusted until validated here.
export interface IdentityAccessRpc {
  authorizeApiAccessV1(request: unknown): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable: AccessDecision = { allowed: false, error: 'access_unavailable', status: 503 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

function actorFrom(value: unknown): QuoteActor | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'partner' && isUuid(value.partnerId)) return { kind: 'partner', partnerId: value.partnerId };
  if (value.kind === 'user' && isRecord(value.principal) && isUuid(value.principal.clientId) && isUuid(value.principal.subjectToken)) {
    return { kind: 'user', clientId: value.principal.clientId, subjectToken: value.principal.subjectToken };
  }
  return null;
}

function decisionFrom(reply: unknown): AccessDecision {
  if (!isRecord(reply)) return unavailable;
  if (reply.allowed === true) {
    const actor = actorFrom(reply.actor);
    return actor ? { allowed: true, actor } : unavailable;
  }
  // This adapter supplies the fixed RPC shape. A 400 is an integration failure,
  // not a recorded authentication denial that can be exposed as 401.
  if (reply.status === 401) return { allowed: false, error: 'unauthorized', status: 401 };
  if (reply.status === 403) return { allowed: false, error: 'forbidden', status: 403 };
  return unavailable;
}

export class IdentityApiAccess implements ApiAccess {
  constructor(private readonly identity: IdentityAccessRpc, private readonly deadlineMs = 2000) {}

  async authorize(credential: AccessCredential, traceId?: string): Promise<AccessDecision> {
    // Preserve the credential kind while dropping oversized untrusted values.
    // Identity then records a canonical denial without receiving the large data.
    const actor = credential.kind === 'partner'
      ? { kind: 'partner', token: credential.token.length <= 8192 ? credential.token : '', operation: 'quotes:create' }
      : { kind: 'web', cookie: credential.cookie.length <= 16384 ? credential.cookie : '',
        origin: credential.origin.length <= 256 ? credential.origin : '', method: credential.method, operation: 'quotes:create' };
    const correlationId = canonicalTraceId(traceId);
    const request = { ...actor, ...(correlationId ? { traceId: correlationId } : {}) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.identity.authorizeApiAccessV1(request),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('access_deadline')), this.deadlineMs); })
      ]);
      return decisionFrom(reply);
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timer);
    }
  }
}
