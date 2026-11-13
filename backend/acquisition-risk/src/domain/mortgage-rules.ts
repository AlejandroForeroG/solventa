// Retained historical artifacts. New tariffs or underwriting rules need a new version;
// changing these functions would change the interpretation of existing captures.
export const MORTGAGE_RATING_VERSION = 'provisional-1';
export const MORTGAGE_UNDERWRITING_VERSION = 'academic-mortgage-1';
const BANDS = [
  { maxAge: 30, ppm: 220 },
  { maxAge: 40, ppm: 270 },
  { maxAge: 50, ppm: 400 },
  { maxAge: 60, ppm: 650 },
  { maxAge: 70, ppm: 1000 }
] as const;

export function mortgageRateV1(age: number): number {
  const band = BANDS.find(b => age <= b.maxAge);
  if (!band || age < 18) throw new RangeError('age_out_of_range');
  return band.ppm;
}

export function mortgagePremiumV1(amount: number, age: number): number {
  return Number((BigInt(amount) * BigInt(mortgageRateV1(age)) + 500000n) / 1000000n);
}

export type MortgageInputs = {
  amount: number; termMonths: number; ageYears: number;
  monthlyIncomeCop: number; monthlyObligationsCop: number; paymentScore: number;
  identityVerified: boolean; affiliationActive: boolean;
};

export function evaluateMortgageV1(inputs: MortgageInputs) {
  const { amount, termMonths, ageYears, monthlyIncomeCop: income, monthlyObligationsCop: debt, paymentScore: score } = inputs;
  if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(ageYears) || ageYears < 18 || ageYears > 70
    || !Number.isSafeInteger(termMonths) || termMonths < 12 || termMonths > 240
    || !Number.isSafeInteger(income) || income < 1 || !Number.isSafeInteger(debt) || debt < 0
    || !Number.isSafeInteger(score) || score < 0 || score > 1000
    || typeof inputs.identityVerified !== 'boolean' || typeof inputs.affiliationActive !== 'boolean') return null;
  const debtRatioPpm = Number(BigInt(debt) * 1000000n / BigInt(income));
  if (!Number.isSafeInteger(debtRatioPpm)) return null;
  const checks = {
    amountWithinLimit: amount <= 999999999999999,
    identityVerified: inputs.identityVerified,
    affiliationActive: inputs.affiliationActive,
    paymentScoreSufficient: score >= 600,
    debtRatioWithinLimit: debtRatioPpm <= 500000,
    discountApplied: score >= 750 && debtRatioPpm <= 300000
  };
  const accepted = checks.amountWithinLimit && checks.identityVerified && checks.affiliationActive && checks.paymentScoreSufficient && checks.debtRatioWithinLimit;
  const adjustmentPpm = checks.discountApplied ? 900000 : 1000000;
  const premium = (BigInt(mortgagePremiumV1(amount, ageYears)) * BigInt(adjustmentPpm) + 500000n) / 1000000n;
  if (premium < 1n) return null;
  return { accepted, premium: `${premium}.0000`, debtRatioPpm, adjustmentPpm, baseRatePpm: mortgageRateV1(ageYears), checks };
}
