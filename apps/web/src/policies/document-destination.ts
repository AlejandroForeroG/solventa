export type PolicyDocumentDestination = { policyId: string };

const KEY = 'solventa.policy-document-destination';
const TTL = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A fragment carries only an opaque record locator, never credentials or document contents.
export function policyDocumentDestination(location: Pick<Location, 'pathname' | 'hash'> = window.location): PolicyDocumentDestination | null {
  if (location.pathname !== '/polizas' || location.hash.length > 100) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const policyId = params.get('policy');
  return params.size === 2 && params.get('section') === 'documents' && policyId && UUID.test(policyId)
    ? { policyId: policyId.toLowerCase() } : null;
}

export function policyDocumentPath(destination: PolicyDocumentDestination): string {
  return '/polizas#' + new URLSearchParams({ policy: destination.policyId, section: 'documents' }).toString();
}

export function clearPolicyDocumentDestination(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* This locator cannot authorize a read. */ }
}

export function savePolicyDocumentDestination(destination: PolicyDocumentDestination, now = Date.now()): boolean {
  if (!UUID.test(destination.policyId)) return false;
  try {
    const raw = JSON.stringify({ version: 1, savedAt: now, policyId: destination.policyId.toLowerCase() });
    window.sessionStorage.setItem(KEY, raw);
    return window.sessionStorage.getItem(KEY) === raw;
  } catch { return false; }
}

export function readPolicyDocumentDestination(now = Date.now()): PolicyDocumentDestination | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    if (raw.length > 200) { clearPolicyDocumentDestination(); return null; }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
      || !('version' in value) || value.version !== 1 || !('savedAt' in value) || typeof value.savedAt !== 'number'
      || !Number.isFinite(value.savedAt) || now < value.savedAt || now - value.savedAt >= TTL
      || !('policyId' in value) || typeof value.policyId !== 'string' || !UUID.test(value.policyId)) {
      clearPolicyDocumentDestination(); return null;
    }
    return { policyId: value.policyId.toLowerCase() };
  } catch { clearPolicyDocumentDestination(); return null; }
}
