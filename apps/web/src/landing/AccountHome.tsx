import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { listPolicies } from '../policies/api';
import { getOwnedCases } from '../claims/case-api';

type Count = number | 'loading' | 'unavailable';
const openStates = new Set(['unassigned', 'in_review', 'pending_information', 'escalated', 'approved']);

export function AccountHome() {
  const intl = useIntl();
  const t = (key: string, values?: Record<string, number>) => intl.formatMessage({ id: `home.${key}` }, values);
  const [policies, setPolicies] = useState<Count>('loading');
  const [claims, setClaims] = useState<Count>('loading');
  useEffect(() => {
    const abort = new AbortController();
    void listPolicies(abort.signal).then(result => {
      if (abort.signal.aborted) return;
      const now = Date.now();
      setPolicies(result.kind === 'ok' ? result.value.policies.filter(item => !item.contractStatus && Date.parse(item.effectiveUntil) > now).length : 'unavailable');
    }).catch(() => { if (!abort.signal.aborted) setPolicies('unavailable'); });
    void getOwnedCases(abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setClaims(result.kind === 'ok' ? result.value.items.filter(item => openStates.has(item.state)).length : 'unavailable');
    }).catch(() => { if (!abort.signal.aborted) setClaims('unavailable'); });
    return () => abort.abort();
  }, []);
  const value = (count: Count) => count === 'loading' ? <span className="home-skeleton" aria-hidden="true" /> : count === 'unavailable' ? '—' : intl.formatNumber(count);
  const label = (count: Count, key: string) => count === 'loading' ? t('loading') : count === 'unavailable' ? t('unavailable') : t(key, { count });
  return <section className="home-cards" aria-label={t('summary')}>
    <a className="card home-card" href="/polizas">
      <span className="home-card-label">{t('policies')}</span>
      <strong className="home-card-value">{value(policies)}</strong>
      <span className="note">{label(policies, 'policiesDetail')}</span>
    </a>
    <a className="card home-card" href="/mis-siniestros">
      <span className="home-card-label">{t('claims')}</span>
      <strong className="home-card-value">{value(claims)}</strong>
      <span className="note">{label(claims, 'claimsDetail')}</span>
    </a>
    <a className="card home-card home-card-action" href="/cotizar">
      <span className="home-card-label">{t('quote')}</span>
      <span className="note">{t('quoteDetail')}</span>
      <span className="home-card-cta" aria-hidden="true">→</span>
    </a>
  </section>;
}
