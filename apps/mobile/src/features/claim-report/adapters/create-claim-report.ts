import { randomUUID } from 'expo-crypto';
import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';
import type { AuthenticatedSession } from '../../policy-wallet/application/ports';
import { ClaimReportFlow } from '../application/claim-report-flow';
import type { EvidenceSource } from '../application/ports';
import { createClaimReportApi } from './claim-report-api';
import { createExpoEvidenceSource } from './expo-evidence-source';
import { expoEvidenceUploader, expoFileDigest } from './expo-file-transfer';

// Composition root of the feature: the only place where the Expo adapters meet the application flow.
export function createClaimReport(baseUrl: string, session: AuthenticatedSession, policy: CachedPolicy): { flow: ClaimReportFlow; source: EvidenceSource } {
  return {
    flow: new ClaimReportFlow({
      policyId: policy.policyId,
      window: { from: new Date(policy.effectiveFrom), until: new Date(policy.effectiveUntil) },
      api: createClaimReportApi(baseUrl, session, expoEvidenceUploader),
      digest: expoFileDigest, newId: randomUUID, now: () => new Date(),
    }),
    source: createExpoEvidenceSource(),
  };
}
