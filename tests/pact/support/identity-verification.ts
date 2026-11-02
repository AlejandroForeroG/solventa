import { verificationHttpSetup } from '../../support/identity-verification-http';
import { verificationIdentity } from '../../support/identity-verification-fakes';

export type VerificationStage = 'empty' | 'draft' | 'ready' | 'not_verified' | 'unavailable' | 'approved' | 'assistance' | 'revoked' | 'expired';
export const verificationCaseId = '00000000-0000-4000-8000-000000000004';
export async function verificationPactWorld(stage: VerificationStage) {
  const r = verificationHttpSetup();
  r.store.users.set(verificationIdentity.providerSubject, {
    clientId: '00000000-0000-4000-8000-000000000001', subjectToken: '00000000-0000-4000-8000-000000000002', session: verificationIdentity.sessionReference,
  });
  let next = 4;
  r.deps.platform.newId = () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
  let view = null;
  if (stage !== 'empty') {
    view = await r.application.grant(r.context('', 'seed-grant'), { textVersion: 1, locale: 'es-CO' });
    if (stage !== 'draft') {
      for (const [step, reference] of [['document', stage === 'unavailable' ? 'document-technical' : ['not_verified', 'assistance'].includes(stage) ? 'document-unreadable' : 'document-readable'],
        ['selfie', 'selfie-matched'], ['liveness', 'liveness-passed']] as const) {
        view = await r.application.saveStep(r.context(view.id, `seed-${step}`), step, r.fixture(reference), view.version);
      }
      if (['not_verified', 'unavailable', 'approved', 'assistance'].includes(stage)) view = await r.application.evaluate(r.context(view.id, 'seed-evaluate'), view.version);
      if (stage === 'assistance') view = await r.application.requestAssistance(r.context(view.id, 'seed-assistance'), view.version);
      if (stage === 'revoked') view = await r.application.revoke(r.context(view.id, 'seed-revoke'));
      if (stage === 'expired') { r.store.now = view.expiresAt; view = await r.application.inspect(verificationIdentity, r.context().traceId); }
    }
  }
  return { ...r, view };
}
