import type { WalletLocale } from './messages';

// Money arrives as an exact decimal string; the wallet shows whole pesos and never converts it to another currency.
export function formatMoney(amount: string, locale: WalletLocale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(amount.split('.')[0]));
}

export function formatDate(value: string | number, locale: WalletLocale): string {
  return new Date(value).toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });
}

export function formatDateTime(value: number, locale: WalletLocale): string {
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
