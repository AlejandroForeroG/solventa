import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPurchaseDraft, readPurchaseDraft, savePurchaseDraft, type PurchaseDraft } from './purchase-draft';

const draft: PurchaseDraft = {
  quoteId: 'COT-2026-08843',
  acceptance: { acceptanceId: '20000000-0000-4000-8000-000000000002', offerId: '10000000-0000-4000-8000-000000000001', acceptedAt: '2026-10-15T00:01:00.000Z', traceId: '50000000-0000-4000-8000-000000000002' },
  issue: { policyId: '30000000-0000-4000-8000-000000000003', documentHash: 'a'.repeat(64), key: '70000000-0000-4000-8000-000000000007',
    challengeId: '80000000-0000-4000-8000-000000000008' }
};
const KEY = 'solventa.purchase-draft';

afterEach(() => { vi.restoreAllMocks(); });

describe('purchase draft', () => {
  it('keeps only server references and the command key across a reload', () => {
    expect(savePurchaseDraft(draft)).toBe(true);
    expect(readPurchaseDraft()).toEqual(draft);
    const stored = JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}');
    expect(Object.keys(stored).sort()).toEqual(['acceptance', 'issue', 'quoteId', 'savedAt', 'version']);
    expect(savePurchaseDraft({ ...draft, issue: null })).toBe(true);
    expect(readPurchaseDraft()?.issue).toBeNull();
    clearPurchaseDraft();
    expect(readPurchaseDraft()).toBeNull();
  });

  it('discards an expired, future or altered draft instead of resuming it', () => {
    savePurchaseDraft(draft);
    const savedAt = JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}').savedAt as number;
    expect(readPurchaseDraft(savedAt + 30 * 60 * 1000)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    savePurchaseDraft(draft);
    expect(readPurchaseDraft(savedAt - 1)).toBeNull();
    for (const altered of [{ ...draft, issue: { ...draft.issue, key: 'chosen-by-user' } }, { ...draft, acceptance: { ...draft.acceptance, acceptanceId: 'x' } },
      { ...draft, quoteId: '<script>' }, { ...draft, issue: { ...draft.issue, documentHash: 'b' } }]) {
      window.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, savedAt: Date.now(), ...altered }));
      expect(readPurchaseDraft(), JSON.stringify(altered)).toBeNull();
    }
    window.sessionStorage.setItem(KEY, '{');
    expect(readPurchaseDraft()).toBeNull();
  });

  it('works without storage: nothing is resumed and saving reports the failure', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    expect(readPurchaseDraft()).toBeNull();
    expect(savePurchaseDraft(draft)).toBe(false);
  });

  it('migrates a legacy issue to acceptance discovery without renewing its lifetime', () => {
    const savedAt = Date.now();
    const legacy = { ...draft, version: 1, savedAt, issue: { policyId: '30000000-0000-4000-8000-000000000003',
      documentHash: 'a'.repeat(64), key: '70000000-0000-4000-8000-000000000007' } };
    window.sessionStorage.setItem(KEY, JSON.stringify(legacy));
    expect(readPurchaseDraft(savedAt + 20 * 60 * 1000)).toEqual({ ...draft, issue: null });
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}').savedAt).toBe(savedAt);
    expect(readPurchaseDraft(savedAt + 30 * 60 * 1000)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('rejects altered legacy commands and explicitly invalid challenge identifiers', () => {
    const legacy = { policyId: '30000000-0000-4000-8000-000000000003', documentHash: 'a'.repeat(64),
      key: '70000000-0000-4000-8000-000000000007' };
    for (const issue of [{ ...legacy, key: 'altered' }, { ...legacy, documentHash: 'invalid' },
      { ...legacy, challengeId: null }, { ...legacy, challengeId: 'invalid' }]) {
      window.sessionStorage.setItem(KEY, JSON.stringify({ ...draft, version: 1, savedAt: Date.now(), issue }));
      expect(readPurchaseDraft()).toBeNull();
    }
  });
});
