import { afterEach, expect, it, vi } from 'vitest';
import { clearPolicyDocumentDestination, policyDocumentDestination, policyDocumentPath, readPolicyDocumentDestination, savePolicyDocumentDestination } from './document-destination';

const policyId = '10000000-0000-4000-8000-000000000001';
afterEach(() => { vi.restoreAllMocks(); clearPolicyDocumentDestination(); });

it('accepts only a bounded policy documents locator on the policy route', () => {
  const hash = '#policy=' + policyId + '&section=documents';
  expect(policyDocumentDestination({ pathname: '/polizas', hash })).toEqual({ policyId });
  expect(policyDocumentPath({ policyId })).toBe('/polizas' + hash);
  for (const value of [hash + '&next=https://example.com', hash + '&policy=' + policyId, hash.replace('documents', 'history'), '#policy=invalid&section=documents']) {
    expect(policyDocumentDestination({ pathname: '/polizas', hash: value })).toBeNull();
  }
  expect(policyDocumentDestination({ pathname: '/', hash })).toBeNull();
});

it('retains only the locator through sign-in and expires or clears it', () => {
  expect(savePolicyDocumentDestination({ policyId }, 1000)).toBe(true);
  expect(readPolicyDocumentDestination(1001)).toEqual({ policyId });
  expect(readPolicyDocumentDestination(999)).toBeNull();
  expect(savePolicyDocumentDestination({ policyId }, 1000)).toBe(true);
  expect(readPolicyDocumentDestination(1000 + 15 * 60 * 1000)).toBeNull();
  expect(savePolicyDocumentDestination({ policyId }, 1000)).toBe(true);
  clearPolicyDocumentDestination();
  expect(readPolicyDocumentDestination(1001)).toBeNull();
});

it('reports unavailable browser storage without retaining another destination', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
  expect(savePolicyDocumentDestination({ policyId })).toBe(false);
  expect(readPolicyDocumentDestination()).toBeNull();
});
