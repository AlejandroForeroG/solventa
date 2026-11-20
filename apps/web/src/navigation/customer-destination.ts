export type PolicyDestination = { kind: 'policy'; policyId: string; section: 'info' | 'documents' | 'history' | 'renewal' };
export type CustomerDestination = PolicyDestination | { kind: 'claim'; claimId: string };
const KEY = 'solventa.policy-document-destination';
const TTL = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A bounded locator survives the login redirect; the destination API still checks the current owner.
export function customerDestination(location: Pick<Location, 'pathname' | 'hash'> = window.location): CustomerDestination | null {
  const claimId = location.pathname.match(/^\/mis-siniestros\/([^/]+)$/)?.[1];
  if (claimId && UUID.test(claimId) && !location.hash) return { kind: 'claim', claimId: claimId.toLowerCase() };
  if (location.pathname !== '/polizas' || location.hash.length > 100) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const policyId = params.get('policy');
  const section = params.get('section');
  return params.size === 2 && policyId && UUID.test(policyId) && (section === 'info' || section === 'documents' || section === 'history' || section === 'renewal')
    ? { kind: 'policy', policyId: policyId.toLowerCase(), section } : null;
}
export function customerDestinationPath(destination: CustomerDestination): string {
  return destination.kind === 'claim' ? `/mis-siniestros/${destination.claimId}`
    : '/polizas#' + new URLSearchParams({ policy: destination.policyId, section: destination.section }).toString();
}
export function clearCustomerDestination(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* A locator never authorizes a read. */ }
}
export function saveCustomerDestination(destination: CustomerDestination, now = Date.now()): boolean {
  const url = new URL(customerDestinationPath(destination), 'https://solventa.invalid');
  const checked = customerDestination(url);
  if (!checked) return false;
  try {
    const raw = JSON.stringify({ version: 2, savedAt: now, destination: checked });
    window.sessionStorage.setItem(KEY, raw);
    return window.sessionStorage.getItem(KEY) === raw;
  } catch { return false; }
}
export function readCustomerDestination(now = Date.now()): CustomerDestination | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    if (raw.length > 320) throw new Error('invalid_locator');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
      || !('savedAt' in value) || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)
      || now < value.savedAt || now - value.savedAt >= TTL || !('version' in value)) throw new Error('invalid_locator');
    if (value.version === 1 && 'policyId' in value && typeof value.policyId === 'string' && UUID.test(value.policyId)) {
      return { kind: 'policy', policyId: value.policyId.toLowerCase(), section: 'documents' };
    }
    if (value.version !== 2 || !('destination' in value) || !value.destination || typeof value.destination !== 'object' || Array.isArray(value.destination)) throw new Error('invalid_locator');
    const dest = value.destination;
    if ('kind' in dest && dest.kind === 'claim' && Object.keys(dest).length === 2 && 'claimId' in dest && typeof dest.claimId === 'string' && UUID.test(dest.claimId)) {
      return { kind: 'claim', claimId: dest.claimId.toLowerCase() };
    }
    if ('kind' in dest && dest.kind === 'policy' && Object.keys(dest).length === 3 && 'policyId' in dest && typeof dest.policyId === 'string' && UUID.test(dest.policyId)
      && 'section' in dest && (dest.section === 'info' || dest.section === 'documents' || dest.section === 'history' || dest.section === 'renewal')) {
      return { kind: 'policy', policyId: dest.policyId.toLowerCase(), section: dest.section };
    }
    throw new Error('invalid_locator');
  } catch { clearCustomerDestination(); return null; }
}
