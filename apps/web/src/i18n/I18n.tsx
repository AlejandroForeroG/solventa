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

// Amounts are always Colombian pesos; the locale only changes the separators.
export function useFormatters() {
  const intl = useIntl();
  return {
    copAmount: (value: number) => intl.formatNumber(value, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }),
    cop: (value: number) => `${intl.formatNumber(value, { style: 'currency', currency: 'COP', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 })} COP`,
    monthYear: (date: Date) => intl.formatDate(date, { month: 'short', year: 'numeric', timeZone: 'America/Bogota' })
  };
}
