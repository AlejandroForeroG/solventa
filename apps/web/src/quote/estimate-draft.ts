import { invalidEstimateFields, type EstimateValues } from './estimate-api';

const KEY = 'solventa.estimate-draft';
const TTL_MS = 30 * 60 * 1000;

export function clearEstimateDraft() {
  try { window.sessionStorage.removeItem(KEY); } catch { /* Storage can be disabled. */ }
}

export function readEstimateDraft(now = Date.now()): EstimateValues | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    if (raw.length > 1024) { clearEstimateDraft(); return null; }
    const draft = JSON.parse(raw);
    if (!draft || draft.version !== 1 || !Number.isFinite(draft.savedAt) || now < draft.savedAt || now - draft.savedAt >= TTL_MS
      || typeof draft.ageYears !== 'string' || typeof draft.amount !== 'string' || typeof draft.termMonths !== 'string') { clearEstimateDraft(); return null; }
    const values = { ageYears: draft.ageYears, amount: draft.amount, termMonths: draft.termMonths };
    if (invalidEstimateFields(values).length) { clearEstimateDraft(); return null; }
    return values;
  } catch { clearEstimateDraft(); return null; }
}

export function saveEstimateDraft(values: EstimateValues): boolean {
  try {
    // Only calculator inputs cross the redirect, never identity fields, credentials or a trusted price.
    window.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, savedAt: Date.now(), ageYears: values.ageYears, amount: values.amount, termMonths: values.termMonths }));
    return true;
  } catch { return false; }
}
