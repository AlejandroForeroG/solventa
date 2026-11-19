import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '../../../apps/mobile/src/features/claim-report/domain/report';

// What the native client and the Policy handler both agree on for the claim report: the declaration, the file and the identities of the first draft.
export const evidenceFile = fileURLToPath(new URL('./evidence-sample.bin', import.meta.url));
export const evidenceBytes = readFileSync(evidenceFile);
export const claimIds = {
  policy: '91000000-0000-4000-8000-000000000020',
  file: '91000000-0000-4000-8000-0000000000e1',
  // The store numbers its claims in order, so the first draft is always this one.
  claim: '91000000-0000-4000-8000-000000000001',
};
export const idempotencyKey = 'pact-report-key-0001';
export const manifest: Manifest = {
  policyId: claimIds.policy,
  eventType: 'collision',
  occurredAt: '2026-11-10T15:00:00.000Z',
  place: 'Autopista Norte con Calle 116',
  location: { authorized: true, latitude: 4.696944, longitude: -74.044167 },
  description: 'Colisión por alcance en la Autopista Norte con Calle 116, sentido sur. El otro vehículo frenó de golpe.',
  evidence: [{ fileId: claimIds.file, contentType: 'image/jpeg', byteSize: evidenceBytes.length, sha256: createHash('sha256').update(evidenceBytes).digest('hex') }],
};
// The provider's clock: after the event, inside the policy window.
export const providerNow = new Date('2026-11-11T00:00:00.000Z');
