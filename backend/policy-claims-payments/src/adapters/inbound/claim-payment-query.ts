import { isUuid } from '../../domain/claim-report';

export function claimPaymentQuery(url: string): { cursor?: string } | null {
  const params = new URL(url).searchParams;
  for (const [key, value] of params) if (key !== 'cursor' || params.getAll(key).length !== 1 || !isUuid(value)) return null;
  const cursor = params.get('cursor');
  return cursor ? { cursor: cursor.toLowerCase() } : {};
}
