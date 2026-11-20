import { NoticeFailure, object, uuid } from './notice';

export type NoticeDestination = { kind: 'policy'; policyId: string; section: 'info' | 'history' | 'renewal' } | { kind: 'claim'; claimId: string };

export function parseDestination(raw: unknown): NoticeDestination {
  if (!object(raw) || !object(raw.destination)) throw new NoticeFailure('invalid_response');
  const value = raw.destination;
  if (value.kind === 'claim' && Object.keys(value).length === 2 && uuid(value.claimId)) return { kind: 'claim', claimId: value.claimId.toLowerCase() };
  if (value.kind === 'policy' && Object.keys(value).length === 3 && uuid(value.policyId)
    && (value.section === 'info' || value.section === 'history' || value.section === 'renewal')) {
    return { kind: 'policy', policyId: value.policyId.toLowerCase(), section: value.section };
  }
  throw new NoticeFailure('invalid_response');
}

export function destinationUrl(baseUrl: string, destination: NoticeDestination): string {
  const url = new URL(destination.kind === 'claim' ? `/mis-siniestros/${destination.claimId}` : '/polizas', baseUrl);
  if (destination.kind === 'policy') url.hash = new URLSearchParams({ policy: destination.policyId, section: destination.section }).toString();
  return url.toString();
}

export function tappedNoticeId(data: unknown): string | null {
  return object(data) && data.screen === 'notice' && uuid(data.eventId) ? data.eventId.toLowerCase() : null;
}
