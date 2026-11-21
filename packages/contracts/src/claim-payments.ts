export type ClaimPayment = { paymentId: string; amount: string; currency: 'COP'; status: 'pending' | 'confirmed' | 'declined'; reference: string | null; simulated: true };
export type OwnClaimPayment = { claimId: string; claimNumber: string; updatedAt: string; payment: ClaimPayment };
export type ClaimPaymentPage = { items: OwnClaimPayment[]; next: string | null };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseClaimPayment(value: unknown): ClaimPayment | null {
  if (!record(value) || !uuid(value.paymentId) || typeof value.amount !== 'string' || !/^(0|[1-9]\d{0,14})\.\d{4}$/.test(value.amount)
    || !/[1-9]/.test(value.amount) || value.currency !== 'COP' || value.simulated !== true
    || (value.status !== 'pending' && value.status !== 'confirmed' && value.status !== 'declined')
    || (value.status === 'confirmed' ? value.reference !== 'MOCK-' + value.paymentId : value.reference !== null)) return null;
  return { paymentId: value.paymentId, amount: value.amount, currency: 'COP', status: value.status,
    reference: typeof value.reference === 'string' ? value.reference : null, simulated: true };
}

export function parseClaimPaymentPage(value: unknown): ClaimPaymentPage | null {
  if (!record(value) || !uuid(value.traceId) || !Array.isArray(value.items) || value.items.length > 6 || (value.next !== null && !uuid(value.next))) return null;
  const items: OwnClaimPayment[] = [];
  for (const item of value.items) {
    if (!record(item) || !uuid(item.claimId) || typeof item.claimNumber !== 'string' || !/^SIN-\d{4}-\d{5}$/.test(item.claimNumber)
      || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) return null;
    const payment = parseClaimPayment(item.payment);
    if (!payment || items.some(previous => previous.claimId === item.claimId)) return null;
    items.push({ claimId: item.claimId, claimNumber: item.claimNumber, updatedAt: item.updatedAt, payment });
  }
  return { items, next: typeof value.next === 'string' ? value.next : null };
}
