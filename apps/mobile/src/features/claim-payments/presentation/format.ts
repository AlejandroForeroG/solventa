export function formatPaymentAmount(amount: string, locale: 'es-CO' | 'en-US'): string {
  const [whole, fraction] = amount.split('.');
  // Validated receipts have at most 15 integer digits; Hermes Intl rejects BigInt.
  const integer = new Intl.NumberFormat(locale).format(Number(whole));
  return integer + (locale === 'es-CO' ? ',' : '.') + fraction + ' COP';
}
