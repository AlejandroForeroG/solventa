import { identityVerificationFixtures } from '@solventa/contracts';
import type { VerificationCorpus } from '../../application/ports/identity-verification';
import type { KycSource } from './kyc-provider';
import { syntheticKycFormat } from './kyc-provider';

export class SyntheticVerificationCorpus implements VerificationCorpus {
  list() { return identityVerificationFixtures; }
  accepts(step: Parameters<VerificationCorpus['accepts']>[0], evidence: Parameters<VerificationCorpus['accepts']>[1]) {
    return identityVerificationFixtures.some(item => item.step === step && item.reference === evidence.reference
      && item.sha256 === evidence.sha256 && item.corpusVersion === evidence.corpusVersion);
  }
}

export const syntheticKycSource: KycSource = async (input, signal) => {
  if (signal.aborted) throw new Error('synthetic_verification_cancelled');
  const corpus = new SyntheticVerificationCorpus();
  for (const step of ['document', 'selfie', 'liveness'] as const) {
    if (!corpus.accepts(step, input.evidence[step])) throw new Error('synthetic_evidence_invalid');
  }
  if (input.evidence.document.reference === 'document-technical') throw new Error('synthetic_verification_unavailable');
  return { formatVersion: syntheticKycFormat, evaluationId: input.evaluationId, providerReference: input.evaluationId,
    simulated: true, completedAt: input.requestedAt,
    checks: {
      document: input.evidence.document.reference === 'document-unreadable' ? 'fail' : 'pass',
      selfie: input.evidence.selfie.reference === 'selfie-mismatched' ? 'fail' : input.evidence.selfie.reference === 'selfie-review' ? 'review' : 'pass',
      liveness: input.evidence.liveness.reference === 'liveness-failed' ? 'fail' : 'pass',
    },
    screening: input.evidence.liveness.reference === 'liveness-screening-match' ? 'match' : 'clear',
  };
};
