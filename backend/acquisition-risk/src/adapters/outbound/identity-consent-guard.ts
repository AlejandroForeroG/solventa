import type { ConsentCheck, ConsentDenial, ConsentGuard } from '../../application/ports/consent-guard';
import type { SignalScope } from '../../domain/signal';

// The Service Binding to Identity (`verifyConsentV1`). Its reply is untrusted until validated here.
export interface IdentityConsentRpc {
  verifyConsentV1(request: unknown): Promise<unknown>;
}

const PURPOSE = 'risk_profiling';
const CONSENT_ID = /^CNS-[0-9]{4}-[0-9]{5,19}$/;
const DENIALS: readonly string[] = ['consent_missing', 'consent_revoked', 'consent_expired', 'consent_invalid', 'invalid_request', 'unavailable'];
const unavailable: ConsentCheck = { allowed: false, reason: 'unavailable' };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function checkFrom(reply: unknown): ConsentCheck {
  if (!isRecord(reply)) return unavailable;
  if (reply.allowed === true) {
    const consent = reply.consent;
    if (isRecord(consent) && typeof consent.consentId === 'string' && CONSENT_ID.test(consent.consentId)
      && typeof consent.textVersion === 'number' && Number.isInteger(consent.textVersion) && typeof consent.expiresAt === 'string' && !Number.isNaN(Date.parse(consent.expiresAt))) {
      return { allowed: true, consentId: consent.consentId, textVersion: consent.textVersion, expiresAt: consent.expiresAt };
    }
    return unavailable;
  }
  return reply.allowed === false && typeof reply.reason === 'string' && DENIALS.includes(reply.reason)
    ? { allowed: false, reason: reply.reason as ConsentDenial }
    : unavailable;
}

export class IdentityConsentGuard implements ConsentGuard {
  constructor(private readonly identity: IdentityConsentRpc, private readonly deadlineMs = 2000) {}

  async verify(subjectToken: string, scope: SignalScope): Promise<ConsentCheck> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.identity.verifyConsentV1({ subjectToken, purposeCode: PURPOSE, scope }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('consent_deadline')), this.deadlineMs); })
      ]);
      return checkFrom(reply);
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timer);
    }
  }
}
