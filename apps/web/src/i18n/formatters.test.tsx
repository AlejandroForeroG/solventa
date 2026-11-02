import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18n, useFormatters, useLocale } from './I18n';

afterEach(cleanup);

function Amount({ value }: { value: string }) {
  const { copDecimalAmount, copDecimal } = useFormatters();
  const { setLocale } = useLocale();
  return <>
    <output data-testid="amount">{copDecimalAmount(value)}</output>
    <output data-testid="currency">{copDecimal(value)}</output>
    <button onClick={() => setLocale('en-US')}>English</button>
  </>;
}

describe('owner decimal currency display', () => {
  for (const [value, es, en] of [
    ['999999999999999.9999', '$\u00a0999.999.999.999.999,9999', '$999,999,999,999,999.9999'],
    ['0.0001', '$\u00a00,0001', '$0.0001'],
    ['1.9999', '$\u00a01,9999', '$1.9999'],
    ['10.0100', '$\u00a010,01', '$10.01'],
    ['1000.1001', '$\u00a01.000,1001', '$1,000.1001'],
    ['0.0000', '$\u00a00', '$0'],
    ['77760.0000', '$\u00a077.760', '$77,760']
  ]) {
    for (const [locale, expected] of [['es-CO', es], ['en-US', en]] as const) {
      it(`preserves the exact value ${value} in ${locale}`, () => {
        render(<I18n initial={locale}><Amount value={value} /></I18n>);
        expect(screen.getByTestId('amount').textContent).toBe(expected);
        expect(screen.getByTestId('currency').textContent).toBe(`${expected} COP`);
      });
    }
  }

  it('changes locale without changing or rounding the owner amount', () => {
    render(<I18n initial="es-CO"><Amount value="999999999999999.9999" /></I18n>);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByTestId('amount').textContent).toBe('$999,999,999,999,999.9999');
    expect(screen.getByTestId('currency').textContent).toBe('$999,999,999,999,999.9999 COP');
  });
});
