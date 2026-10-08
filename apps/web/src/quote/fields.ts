import type { QuoteValues, ServerFieldError } from './api';

export type FieldKey = keyof QuoteValues;
export type FieldProblem = { key: FieldKey; message: string; values?: Record<string, number> };

export const fieldOrder: FieldKey[] = ['fullName', 'documentNumber', 'birthDate', 'city', 'amount', 'termMonths'];

const serverFields: Record<string, FieldKey> = {
  'customer.fullName': 'fullName',
  'customer.documentNumber': 'documentNumber',
  'customer.documentType': 'documentNumber',
  'customer.birthDate': 'birthDate',
  'customer.city': 'city',
  'credit.amount': 'amount',
  'credit.termMonths': 'termMonths'
};

// Saves a round trip; the server stays the authority for age and ranges.
export function checkLocally(values: QuoteValues): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const key of fieldOrder) if (!values[key].trim()) problems.push({ key, message: 'field.required' });
  const has = (key: FieldKey) => problems.some(p => p.key === key);
  if (!has('documentNumber') && !/^[0-9]{6,10}$/.test(values.documentNumber.trim())) problems.push({ key: 'documentNumber', message: 'field.invalidDocument' });
  if (!has('amount') && !/^[1-9][0-9]*$/.test(values.amount.trim())) problems.push({ key: 'amount', message: 'field.amount' });
  if (!has('termMonths') && !/^[0-9]+$/.test(values.termMonths.trim())) problems.push({ key: 'termMonths', message: 'field.term', values: { min: 12, max: 240 } });
  return problems;
}

// Errors that name no form field (for example the product) show only in the banner.
export function fromServer(errors: ServerFieldError[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const error of errors) {
    const key = serverFields[error.field];
    if (!key || problems.some(p => p.key === key)) continue;
    const values = error.params;
    switch (error.code) {
      case 'required': problems.push({ key, message: 'field.required' }); break;
      case 'age_out_of_range': problems.push({ key, message: 'field.age', values }); break;
      case 'amount_out_of_range': problems.push({ key, message: 'field.amount' }); break;
      case 'term_out_of_range': problems.push({ key, message: 'field.term', values }); break;
      case 'invalid_type': problems.push({ key, message: 'field.invalidType' }); break;
      default: problems.push({ key, message: key === 'documentNumber' ? 'field.invalidDocument' : 'field.invalidFormat' });
    }
  }
  return problems;
}
