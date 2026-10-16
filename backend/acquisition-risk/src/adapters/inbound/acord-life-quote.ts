import type { FieldError, FieldErrorCode } from '../../domain/quote';
import type { CreateQuoteResult } from '../../application/create-quote';

// Translates Solventa's ACORD Life inspired quote messages (schemas acord-life-quote-*.v1.json in
// packages/contracts) to and from the internal quote model. It checks only the envelope; field rules
// stay in the domain, and their errors are returned with the ACORD path the partner sent.
export const ACORD_SCHEMA_VERSION = '1';

export type AcordErrorCode = FieldErrorCode | 'unsupported_version' | 'unsupported_transaction' | 'unsupported_currency';
export type AcordFieldError = { field: string; code: AcordErrorCode; params?: Record<string, number> };
export type AcordReading = { ok: true; request: Record<string, unknown> } | { ok: false; errors: AcordFieldError[] };
export type QuoteIssued = Extract<CreateQuoteResult, { status: 'created' | 'replayed' }>;

const PRODUCTS = new Map<unknown, string>([['MORTGAGE_LIFE', 'vida_hipotecario']]);
const ACORD_PATHS = new Map<string, string>([
  ['', 'TXLifeRequest'],
  ['product', 'TXLifeRequest.Holding.Policy.ProductCode'],
  ['customer', 'TXLifeRequest.Party'],
  ['customer.fullName', 'TXLifeRequest.Party.FullName'],
  ['customer.documentType', 'TXLifeRequest.Party.GovtIDTC'],
  ['customer.documentNumber', 'TXLifeRequest.Party.GovtID'],
  ['customer.birthDate', 'TXLifeRequest.Party.BirthDate'],
  ['customer.city', 'TXLifeRequest.Party.City'],
  ['credit', 'TXLifeRequest.Holding.Loan'],
  ['credit.partnerCreditId', 'TXLifeRequest.Holding.Loan.LoanNumber'],
  ['credit.amount', 'TXLifeRequest.Holding.Loan.LoanAmt'],
  ['credit.termMonths', 'TXLifeRequest.Holding.Loan.LoanTermMonths']
]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const productCodeOf = (request: Record<string, unknown>) => (isObject(request.Holding) && isObject(request.Holding.Policy) ? request.Holding.Policy.ProductCode : undefined);
const definedOnly = (source: Record<string, unknown>) => Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
// A container that is not an object is passed through so the domain reports it with its usual code.
const mapObject = (value: unknown, map: (source: Record<string, unknown>) => Record<string, unknown>) => (isObject(value) ? definedOnly(map(value)) : value);

function envelopeErrors(message: unknown): AcordFieldError[] {
  if (!isObject(message)) return [{ field: '', code: 'invalid_type' }];
  if (message.schemaVersion !== ACORD_SCHEMA_VERSION) return [{ field: 'schemaVersion', code: 'unsupported_version' }];
  const request = message.TXLifeRequest;
  if (request === undefined) return [{ field: 'TXLifeRequest', code: 'required' }];
  if (!isObject(request)) return [{ field: 'TXLifeRequest', code: 'invalid_type' }];
  if (request.TransType !== 'QuoteRequest') return [{ field: 'TXLifeRequest.TransType', code: 'unsupported_transaction' }];
  const loan = isObject(request.Holding) ? request.Holding.Loan : undefined;
  if (isObject(loan) && loan.CurrencyTypeCode !== 'COP') return [{ field: 'TXLifeRequest.Holding.Loan.CurrencyTypeCode', code: 'unsupported_currency' }];
  const productCode = productCodeOf(request);
  if (productCode !== undefined && !PRODUCTS.has(productCode)) return [{ field: 'TXLifeRequest.Holding.Policy.ProductCode', code: 'unsupported_product' }];
  return [];
}

export function readAcordQuoteRequest(message: unknown): AcordReading {
  const errors = envelopeErrors(message);
  if (errors.length || !isObject(message) || !isObject(message.TXLifeRequest)) return { ok: false, errors };
  const { Party: party, Holding: holding } = message.TXLifeRequest;
  const request = definedOnly({
    product: PRODUCTS.get(productCodeOf(message.TXLifeRequest)),
    customer: mapObject(party, p => ({ fullName: p.FullName, documentType: p.GovtIDTC, documentNumber: p.GovtID, birthDate: p.BirthDate, city: p.City })),
    credit: mapObject(isObject(holding) ? holding.Loan : undefined, l => ({ partnerCreditId: l.LoanNumber, amount: l.LoanAmt, termMonths: l.LoanTermMonths }))
  });
  return { ok: true, request };
}

export function acordFieldErrors(errors: FieldError[]): AcordFieldError[] {
  return errors.map(error => ({ ...error, field: ACORD_PATHS.get(error.field) ?? error.field }));
}

export function writeAcordQuoteResponse(result: QuoteIssued) {
  const { quote } = result;
  return {
    schemaVersion: ACORD_SCHEMA_VERSION,
    TXLifeResponse: {
      TransType: 'QuoteResponse',
      TransRefGUID: quote.traceId,
      TransResult: { ResultCode: 'Success', Replayed: result.status === 'replayed' },
      Quote: {
        QuoteNumber: quote.quoteId,
        ProductCode: 'MORTGAGE_LIFE',
        ModalPremiumAmt: quote.premiumMonthly,
        PaymentMode: 'Monthly',
        FaceAmt: quote.sumInsured,
        TermMonths: quote.termMonths,
        CurrencyTypeCode: quote.currency,
        ExpirationDate: quote.validUntil,
        RateVersion: quote.ruleVersion,
        QuoteBasis: 'MinimumData'
      }
    }
  };
}

export function writeAcordFailure(errors: AcordFieldError[], traceId: string) {
  return {
    schemaVersion: ACORD_SCHEMA_VERSION,
    TXLifeResponse: {
      TransType: 'QuoteResponse',
      TransRefGUID: traceId,
      TransResult: {
        ResultCode: 'Failure',
        ResultInfo: errors.map(error => ({ ResultInfoCode: error.code, PropertyPath: error.field, ...(error.params ? { Params: error.params } : {}) }))
      }
    }
  };
}
