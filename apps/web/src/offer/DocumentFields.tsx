import { useIntl } from 'react-intl';
import type { ReactNode } from 'react';
import { useFormatters } from '../i18n/I18n';

const labels: Record<string, string> = {
  coverage: 'coverage', kind: 'kind', sumInsured: 'sumInsured', currency: 'currency', premium: 'premium',
  effectiveFrom: 'from', effectiveUntil: 'until', offerId: 'offerId', offerVersion: 'version',
  policyId: 'policyId', ruleVersion: 'rule', providerMode: 'provider', synthetic: 'synthetic',
};
const technical = new Set(['offerId', 'offerVersion', 'policyId', 'ruleVersion', 'providerMode', 'synthetic']);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// This is a readable projection of the original document; the download, hash and signature still bind its unchanged bytes.
export function DocumentFields({ document, verification }: { document: Record<string, unknown>; verification?: ReactNode }) {
  const intl = useIntl();
  const { copDecimal, dateTime } = useFormatters();
  const t = (key: string) => intl.formatMessage({ id: `document.${key}` });
  const valueText = (key: string, value: unknown): string => {
    if (typeof value === 'boolean') return t(value ? 'yes' : 'no');
    if (value === null) return t('absent');
    if (typeof value === 'number') return intl.formatNumber(value);
    if (typeof value !== 'string') return String(value);
    if (['premium', 'sumInsured'].includes(key) && /^(0|[1-9][0-9]{0,14})\.[0-9]{4}$/.test(value)) return copDecimal(value);
    if (['effectiveFrom', 'effectiveUntil'].includes(key) && Number.isFinite(Date.parse(value))) return dateTime(new Date(value));
    if (key === 'kind' && value === 'mortgage_life') return t('mortgageLife');
    if (key === 'providerMode' && value === 'mock') return t('mock');
    return value;
  };
  const fields = (values: Record<string, unknown>) => <dl className="document-fields">
    {Object.entries(values).map(([key, value]) => <div key={key} className={isRecord(value) || Array.isArray(value) ? 'document-fields-group' : undefined}>
      <dt>{labels[key] ? t(labels[key]) : key}</dt>
      <dd>{isRecord(value) ? fields(value) : Array.isArray(value)
        ? <ul>{value.map((entry, index) => <li key={index}>{isRecord(entry) ? fields(entry) : valueText(key, entry)}</li>)}</ul>
        : valueText(key, value)}</dd>
    </div>)}
  </dl>;
  const entries = Object.entries(document);
  return <>
    {fields(Object.fromEntries(entries.filter(([key]) => !technical.has(key))))}
    {(verification || entries.some(([key]) => technical.has(key))) && <details className="document-verification"><summary>{t('verification')}</summary>
      {fields(Object.fromEntries(entries.filter(([key]) => technical.has(key))))}
      {verification}
    </details>}
  </>;
}
