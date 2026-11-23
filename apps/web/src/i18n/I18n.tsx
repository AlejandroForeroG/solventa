import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IntlProvider, useIntl } from 'react-intl';
import { messages, type Locale } from './messages';

const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({ locale: 'es-CO', setLocale: () => {} });
export const useLocale = () => useContext(LocaleContext);

function remembered(): Locale {
  try { const saved = window.localStorage.getItem('solventa.locale'); if (saved === 'es-CO' || saved === 'en-US') return saved; } catch { /* storage unavailable */ }
  return 'es-CO';
}

export function I18n({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initial ?? remembered);
  useEffect(() => {
    document.documentElement.lang = locale;
    try { window.localStorage.setItem('solventa.locale', locale); } catch { /* storage unavailable */ }
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale }), [locale]);
  return <LocaleContext.Provider value={value}>
    <IntlProvider locale={locale} messages={messages[locale]} defaultLocale="es-CO">{children}</IntlProvider>
  </LocaleContext.Provider>;
}

export const keepMeridiem = (text: string) => text.replace(/\s([ap])\.\s?m\./g, '\u00a0$1.\u00a0m.');

// Amounts are always Colombian pesos; the locale only changes the separators.
export function useFormatters() {
  const intl = useIntl();
  const copDecimalAmount = (value: string) => {
    if (!/^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(value)) throw new RangeError('Invalid owner decimal amount');
    const fraction = value.slice(-4).replace(/0+$/, '');
    // Intl groups the exact integer; replacing its zero fraction preserves the owner's decimal digits.
    return new Intl.NumberFormat(intl.locale, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: fraction.length, maximumFractionDigits: fraction.length })
      .formatToParts(BigInt(value.slice(0, -5))).map(part => part.type === 'fraction' ? fraction : part.value).join('');
  };
  const copRounded = (value: string) => {
    if (!/^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(value)) throw new RangeError('Invalid owner decimal amount');
    const [whole, fraction] = value.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1n : 0n);
    const units = cents / 100n, rest = (cents % 100n).toString().padStart(2, '0');
    const digits = rest === '00' ? 0 : 2;
    return new Intl.NumberFormat(intl.locale, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits })
      .formatToParts(units).map(part => part.type === 'fraction' ? rest : part.value).join('');
  };
  return {
    copRounded,
    copAmount: (value: number) => intl.formatNumber(value, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }),
    cop: (value: number) => `${intl.formatNumber(value, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 })} COP`,
    copDecimalAmount,
    copDecimal: (value: string) => `${copDecimalAmount(value)} COP`,
    dateTime: (date: Date) => keepMeridiem(intl.formatDate(date, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })),
    longDate: (date: Date) => intl.formatDate(date, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }),
    longDateTime: (date: Date) => keepMeridiem(intl.formatDate(date, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })),
    monthYear: (date: Date) => intl.formatDate(date, { month: 'short', year: 'numeric', timeZone: 'America/Bogota' }),
    dayMonthYear: (date: Date) => intl.formatDate(date, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Bogota' }),
    shortDate: (date: Date) => intl.formatDate(date, intl.locale.startsWith('es')
      ? { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Bogota' }
      : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Bogota' })
  };
}
