export type EstimateValues = { ageYears: string; amount: string; termMonths: string };
export type Estimate = { premiumMonthly: number; currency: 'COP'; sumInsured: number; termMonths: number; basis: 'minimum_data'; ruleVersion: string; traceId: string };
export type EstimateField = keyof EstimateValues;
export type EstimateOutcome = { kind: 'estimate'; estimate: Estimate } | { kind: 'invalid'; fields: EstimateField[] } | { kind: 'unavailable' };
export const estimateFields: EstimateField[] = ['ageYears', 'amount', 'termMonths'];

export function invalidEstimateFields(values: EstimateValues): EstimateField[] {
  return estimateFields.filter(key => {
    const value = Number(values[key]);
    return !/^[0-9]+$/.test(values[key]) || !Number.isSafeInteger(value)
      || (key === 'ageYears' ? value < 18 || value > 70 : key === 'amount' ? value < 1 : value < 12 || value > 240);
  });
}

export async function requestEstimate(values: EstimateValues, signal?: AbortSignal): Promise<EstimateOutcome> {
  try {
    const response = await fetch('/api/v1/quote-estimates', {
      method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ageYears: Number(values.ageYears), amount: Number(values.amount), termMonths: Number(values.termMonths) }), signal
    });
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'unavailable' };
    const result = body as Record<string, unknown>;
    if (response.status === 400 && Array.isArray(result.errors)) {
      const fields = estimateFields.filter(key => result.errors instanceof Array && result.errors.some(error => error?.field === key));
      return fields.length ? { kind: 'invalid', fields } : { kind: 'unavailable' };
    }
    if (response.status !== 200 || result.currency !== 'COP' || result.basis !== 'minimum_data'
      || typeof result.premiumMonthly !== 'number' || !Number.isSafeInteger(result.premiumMonthly) || result.premiumMonthly < 0
      || result.sumInsured !== Number(values.amount) || result.termMonths !== Number(values.termMonths)
      || typeof result.ruleVersion !== 'string' || !result.ruleVersion.length
      || typeof result.traceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.traceId)) return { kind: 'unavailable' };
    return { kind: 'estimate', estimate: result as Estimate };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { kind: 'unavailable' };
  }
}
