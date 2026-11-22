import { expect, it } from 'vitest';
import { groupedDigits, invalidEstimateFields } from './estimate-api';

it('accepts an amount written with Colombian thousands separators and leaves other text for validation', () => {
  expect(groupedDigits('320.000.000')).toBe('320000000');
  expect(groupedDigits('320 000 000')).toBe('320000000');
  expect(groupedDigits('320000000')).toBe('320000000');
  expect(groupedDigits('32.00')).toBe('32.00');
  expect(invalidEstimateFields({ ageYears: '35', amount: groupedDigits('320.000.000'), termMonths: '120' })).toEqual([]);
});
