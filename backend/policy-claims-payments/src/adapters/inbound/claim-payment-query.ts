import { isUuid } from '../../domain/claim-report';

export function claimPaymentQuery(url: string): { cursor?: string; claimId?: string } | null {
  const params = new URL(url).searchParams;
  if (params.size > 1) return null;
  for (const [key, value] of params) if ((key !== 'cursor' && key !== 'claimId') || !isUuid(value)) return null;
  const cursor = params.get('cursor');
  const claimId = params.get('claimId');
  return cursor ? { cursor: cursor.toLowerCase() } : claimId ? { claimId: claimId.toLowerCase() } : {};
}
