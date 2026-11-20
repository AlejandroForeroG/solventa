import { afterEach, expect, it, vi } from 'vitest';
import { clearCustomerDestination, customerDestination, customerDestinationPath, readCustomerDestination, saveCustomerDestination } from './customer-destination';
const id = '10000000-0000-4000-8000-000000000001';
afterEach(() => { vi.restoreAllMocks(); clearCustomerDestination(); });
it('retains each category action through login without accepting a URL or a different route', () => {
  const targets = [
    ...(['info', 'documents', 'history', 'renewal'] as const).map(section => ({ kind: 'policy' as const, policyId: id, section })),
    { kind: 'claim' as const, claimId: id },
  ];
  for (const target of targets) {
    const url = new URL(customerDestinationPath(target), 'https://dev.solventa.site');
    expect(customerDestination(url)).toEqual(target);
    expect(saveCustomerDestination(target, 1000)).toBe(true);
    expect(readCustomerDestination(1001)).toEqual(target);
  }
  for (const path of [`/polizas#policy=${id}&section=history&next=https://example.com`, `/polizas#policy=${id}&section=history&section=renewal`, '/mis-siniestros/invalid', `/siniestros/${id}`, `/mis-siniestros/${id}#external`]) {
    expect(customerDestination(new URL(path, 'https://dev.solventa.site'))).toBeNull();
  }
});
it('expires the locator, preserves old document handoffs, and rejects malformed storage', () => {
  const key = 'solventa.policy-document-destination';
  window.sessionStorage.setItem(key, JSON.stringify({ version: 1, savedAt: 1000, policyId: id }));
  expect(readCustomerDestination(1001)).toEqual({ kind: 'policy', policyId: id, section: 'documents' });
  expect(readCustomerDestination(901000)).toBeNull();
  for (const raw of ['{', JSON.stringify({ version: 2, savedAt: 1000, destination: { kind: 'claim', claimId: id, url: 'https://example.com' } })]) {
    window.sessionStorage.setItem(key, raw);
    expect(readCustomerDestination(1001)).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  }
  expect(saveCustomerDestination({ kind: 'claim', claimId: id }, 1000)).toBe(true);
  expect(readCustomerDestination(999)).toBeNull();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  expect(saveCustomerDestination({ kind: 'claim', claimId: id })).toBe(false);
});
