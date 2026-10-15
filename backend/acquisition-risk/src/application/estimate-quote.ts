import { calculateEstimate, validateEstimate } from '../domain/quote-estimate';

// An anonymous calculator neither creates a quote nor makes an underwriting decision.
export class EstimateQuote {
  execute(input: unknown) {
    const checked = validateEstimate(input);
    return checked.ok ? { status: 'estimated' as const, estimate: calculateEstimate(checked.value) } : { status: 'invalid' as const, errors: checked.errors };
  }
}
