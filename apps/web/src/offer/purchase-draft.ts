import type { Acceptance } from './api';

const KEY = 'solventa.purchase-draft';
// The offer and signing window lasts 15 minutes; after that, Policy recovery owns any charge left behind.
const TTL_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

// Only server references and the command key survive a reload: never form fields, identity data or amounts.
export type PurchaseDraft = {
  quoteId: string;
  acceptance: Acceptance;
  issue: { policyId: string; documentHash: string; key: string; challengeId: string } | null;
  charge?: { policyId: string; documentHash: string; key: string } | null;
};

export function clearPurchaseDraft() {
  try { window.sessionStorage.removeItem(KEY); } catch { /* Storage can be disabled. */ }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const instant = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function readPurchaseDraft(now = Date.now()): PurchaseDraft | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    if (raw.length > 1024) { clearPurchaseDraft(); return null; }
    const draft: unknown = JSON.parse(raw);
    if (!isRecord(draft) || draft.version !== 1 || typeof draft.savedAt !== 'number' || now < draft.savedAt || now - draft.savedAt >= TTL_MS
      || typeof draft.quoteId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(draft.quoteId) || !isRecord(draft.acceptance)) { clearPurchaseDraft(); return null; }
    const { acceptanceId, offerId, acceptedAt, traceId } = draft.acceptance;
    if (!uuid(acceptanceId) || !uuid(offerId) || !instant(acceptedAt) || !uuid(traceId)) { clearPurchaseDraft(); return null; }
    const acceptance = { acceptanceId, offerId, acceptedAt, traceId };
    const charge = draft.charge == null ? null : draft.charge;
    if (charge !== null && (!isRecord(charge) || !uuid(charge.policyId) || typeof charge.documentHash !== 'string'
      || !HASH.test(charge.documentHash) || !uuid(charge.key))) { clearPurchaseDraft(); return null; }
    const savedCharge = charge === null ? null : { policyId: charge.policyId as string, documentHash: charge.documentHash as string, key: charge.key as string };
    if (draft.issue === null) return { quoteId: draft.quoteId, acceptance, issue: null,
      ...(savedCharge ? { charge: savedCharge } : {}) };
    if (!isRecord(draft.issue)) { clearPurchaseDraft(); return null; }
    const { policyId, documentHash, key, challengeId } = draft.issue;
    if (!uuid(policyId) || typeof documentHash !== 'string' || !HASH.test(documentHash) || !uuid(key) || !uuid(challengeId)) { clearPurchaseDraft(); return null; }
    return { quoteId: draft.quoteId, acceptance, issue: { policyId, documentHash, key, challengeId },
      ...(savedCharge ? { charge: savedCharge } : {}) };
  } catch { clearPurchaseDraft(); return null; }
}

export function savePurchaseDraft(draft: PurchaseDraft): boolean {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, savedAt: Date.now(), quoteId: draft.quoteId, acceptance: draft.acceptance, issue: draft.issue,
      ...(draft.charge ? { charge: draft.charge } : {}) }));
    return true;
  } catch { return false; }
}
