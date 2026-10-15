import { MAX_AGE, MAX_TERM, MIN_AGE, MIN_TERM, monthlyPremium, RULE_VERSION, type FieldError } from './quote';

export type EstimateInput = { ageYears: number; amount: number; termMonths: number };
export type QuoteEstimate = {
  premiumMonthly: number;
  currency: 'COP';
  sumInsured: number;
  termMonths: number;
  basis: 'minimum_data';
  ruleVersion: string;
};

export function validateEstimate(input: unknown): { ok: true; value: EstimateInput } | { ok: false; errors: FieldError[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: [{ field: '', code: 'invalid_type' }] };
  const source = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (Object.keys(source).some(key => !['ageYears', 'amount', 'termMonths'].includes(key))) errors.push({ field: '', code: 'invalid_format' });
  const fields = [
    { key: 'ageYears', min: MIN_AGE, max: MAX_AGE, code: 'age_out_of_range' },
    { key: 'amount', min: 1, max: Number.MAX_SAFE_INTEGER, code: 'amount_out_of_range' },
    { key: 'termMonths', min: MIN_TERM, max: MAX_TERM, code: 'term_out_of_range' }
  ] as const;
  for (const { key, min, max, code } of fields) {
    const value = source[key];
    if (value === undefined) errors.push({ field: key, code: 'required' });
    else if (typeof value !== 'number' || !Number.isSafeInteger(value)) errors.push({ field: key, code: 'invalid_type' });
    else if (value < min || value > max) errors.push({ field: key, code, params: { min, max } });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: source as EstimateInput };
}

export function calculateEstimate(input: EstimateInput): QuoteEstimate {
  return {
    premiumMonthly: monthlyPremium(input.amount, input.ageYears), currency: 'COP',
    sumInsured: input.amount, termMonths: input.termMonths, basis: 'minimum_data', ruleVersion: RULE_VERSION
  };
}
