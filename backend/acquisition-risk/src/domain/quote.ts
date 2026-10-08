// provisional-1 is a placeholder rate table, not an actuarial tariff.
export const RULE_VERSION = 'provisional-1';
export const MIN_AGE = 18;
export const MAX_AGE = 70;
export const MIN_TERM = 12;
export const MAX_TERM = 240;
export const VALIDITY_DAYS = 30;

const BANDS = [
  { maxAge: 30, ppm: 220 },
  { maxAge: 40, ppm: 270 },
  { maxAge: 50, ppm: 400 },
  { maxAge: 60, ppm: 650 },
  { maxAge: 70, ppm: 1000 }
] as const;

export type FieldErrorCode = 'required' | 'invalid_type' | 'invalid_format' | 'age_out_of_range' | 'amount_out_of_range' | 'term_out_of_range' | 'unsupported_product';
export type FieldError = { field: string; code: FieldErrorCode; params?: Record<string, number> };

export type QuoteRequest = {
  product: 'vida_hipotecario';
  customer: { fullName: string; documentType: 'CC'; documentNumber: string; birthDate: string; city: string };
  credit: { partnerCreditId: string; amount: number; termMonths: number };
};

export type DecisionCapture = {
  schemaVersion: 1;
  contractVersion: 'v1';
  correlationId: string;
  inputs: { product: string; ageYears: number; amount: number; termMonths: number; ratePpm: number; partnerCreditId: string };
  sources: [];
  consent: { status: 'not_required' };
  rule: { id: 'quote-rating'; version: string };
  outcome: 'quoted';
};

export function decisionCapture(request: QuoteRequest, ageYears: number, correlationId: string): DecisionCapture {
  const { product, credit } = request;
  return {
    schemaVersion: 1,
    contractVersion: 'v1',
    correlationId,
    inputs: { product, ageYears, amount: credit.amount, termMonths: credit.termMonths, ratePpm: ratePpm(ageYears), partnerCreditId: credit.partnerCreditId },
    sources: [],
    consent: { status: 'not_required' },
    rule: { id: 'quote-rating', version: RULE_VERSION },
    outcome: 'quoted'
  };
}

export type Validation = { ok: true; request: QuoteRequest } | { ok: false; errors: FieldError[] };

// Whole years completed on asOf. Both dates are YYYY-MM-DD in the same calendar (Bogota).
export function ageOn(birthDate: string, asOf: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ay, am, ad] = asOf.split('-').map(Number);
  return ay - by - (am < bm || (am === bm && ad < bd) ? 1 : 0);
}

// The applied rate is stored in the capture so a premium can be explained after the rule table changes.
export function ratePpm(age: number): number {
  const band = BANDS.find(b => age <= b.maxAge);
  if (!band || age < MIN_AGE) throw new RangeError('age_out_of_range');
  return band.ppm;
}

export function monthlyPremium(amount: number, age: number): number {
  const rate = ratePpm(age);
  // BigInt avoids losing precision when amount * ppm exceeds 2^53; the result never exceeds amount.
  return Number((BigInt(amount) * BigInt(rate) + 500000n) / 1000000n);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);

function text(source: Record<string, unknown>, key: string, path: string, max: number, errors: FieldError[]) {
  const value = source[key];
  if (value === undefined) errors.push({ field: path, code: 'required' });
  else if (typeof value !== 'string') errors.push({ field: path, code: 'invalid_type' });
  else if (value.length < 1 || value.length > max) errors.push({ field: path, code: 'invalid_format' });
  return value as string;
}

function strictKeys(source: Record<string, unknown>, allowed: string[], prefix: string, errors: FieldError[]) {
  for (const key of Object.keys(source)) if (!allowed.includes(key)) errors.push({ field: prefix + key, code: 'invalid_format' });
}

export function validateQuoteRequest(input: unknown, asOf: string): Validation {
  const errors: FieldError[] = [];
  if (!isObject(input)) return { ok: false, errors: [{ field: '', code: 'invalid_type' }] };
  strictKeys(input, ['product', 'customer', 'credit'], '', errors);
  if (input.product === undefined) errors.push({ field: 'product', code: 'required' });
  else if (input.product !== 'vida_hipotecario') errors.push({ field: 'product', code: 'unsupported_product' });

  const customer = input.customer;
  if (customer === undefined) errors.push({ field: 'customer', code: 'required' });
  else if (!isObject(customer)) errors.push({ field: 'customer', code: 'invalid_type' });
  else {
    strictKeys(customer, ['fullName', 'documentType', 'documentNumber', 'birthDate', 'city'], 'customer.', errors);
    text(customer, 'fullName', 'customer.fullName', 120, errors);
    text(customer, 'city', 'customer.city', 80, errors);
    if (customer.documentType === undefined) errors.push({ field: 'customer.documentType', code: 'required' });
    else if (customer.documentType !== 'CC') errors.push({ field: 'customer.documentType', code: 'invalid_format' });
    const doc = text(customer, 'documentNumber', 'customer.documentNumber', 10, errors);
    if (typeof doc === 'string' && !/^[0-9]{6,10}$/.test(doc) && !errors.some(e => e.field === 'customer.documentNumber')) errors.push({ field: 'customer.documentNumber', code: 'invalid_format' });
    const birth = customer.birthDate;
    if (birth === undefined) errors.push({ field: 'customer.birthDate', code: 'required' });
    else if (typeof birth !== 'string') errors.push({ field: 'customer.birthDate', code: 'invalid_type' });
    else if (!validDate(birth)) errors.push({ field: 'customer.birthDate', code: 'invalid_format' });
    else {
      const age = ageOn(birth, asOf);
      if (age < MIN_AGE || age > MAX_AGE) errors.push({ field: 'customer.birthDate', code: 'age_out_of_range', params: { age, min: MIN_AGE, max: MAX_AGE } });
    }
  }

  const credit = input.credit;
  if (credit === undefined) errors.push({ field: 'credit', code: 'required' });
  else if (!isObject(credit)) errors.push({ field: 'credit', code: 'invalid_type' });
  else {
    strictKeys(credit, ['partnerCreditId', 'amount', 'termMonths'], 'credit.', errors);
    text(credit, 'partnerCreditId', 'credit.partnerCreditId', 64, errors);
    const { amount, termMonths } = credit;
    if (amount === undefined) errors.push({ field: 'credit.amount', code: 'required' });
    else if (typeof amount !== 'number' || !Number.isInteger(amount)) errors.push({ field: 'credit.amount', code: 'invalid_type' });
    else if (amount < 1 || !Number.isSafeInteger(amount)) errors.push({ field: 'credit.amount', code: 'amount_out_of_range', params: { min: 1 } });
    if (termMonths === undefined) errors.push({ field: 'credit.termMonths', code: 'required' });
    else if (typeof termMonths !== 'number' || !Number.isInteger(termMonths)) errors.push({ field: 'credit.termMonths', code: 'invalid_type' });
    else if (termMonths < MIN_TERM || termMonths > MAX_TERM) errors.push({ field: 'credit.termMonths', code: 'term_out_of_range', params: { min: MIN_TERM, max: MAX_TERM } });
  }
  return errors.length ? { ok: false, errors } : { ok: true, request: input as QuoteRequest };
}
