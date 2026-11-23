import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { readPartnerPortal, type PortalOutcome } from './api';
import { CalendarDateInput } from '../forms/CalendarDateInput';
import { dateRangeProblem, type DateRangeProblem } from '../forms/date-range';
import { AccessDenied } from '../navigation/AccessDenied';
import '../audit/audit.css';
import './portal.css';
import { Icon } from '../navigation/Icon';

export function PartnerPortal({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `partnerPortal.${key}` });
  const [period, setPeriod] = useState(() => ({ from: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }));
  const [draft, setDraft] = useState(period);
  const [problem, setProblem] = useState<DateRangeProblem>(null);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: PortalOutcome } | null>(null);
  const generation = useRef(0);
  const key = period.from + '|' + period.to;
  useEffect(() => {
    if (document.hidden) return;
    const abort = new AbortController();
    const requestGeneration = ++generation.current;
    void readPartnerPortal(period.from, period.to, abort.signal).then(value => {
      if (abort.signal.aborted || document.hidden || requestGeneration !== generation.current) return;
      if (value.kind === 'unauthenticated') onSessionLost();
      setResult({ key, value });
    });
    return () => abort.abort();
  }, [key, period, refresh, onSessionLost]);
  useEffect(() => {
    const update = () => { setResult(null); setRefresh(v => v + 1); };
    const visible = () => { if (document.hidden) { generation.current++; setResult(null); } else update(); };
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => { if (!document.hidden) update(); }, 60000);
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', visible); clearInterval(timer); };
  }, []);
  const state = result?.key === key ? result.value : null;
  const page = state?.kind === 'ok' ? state.value : null;
  const day = (value: string) => { const [y, m, d] = value.split('-'); return intl.locale === 'es-CO' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`; };
  const timestamp = (value: string) => intl.formatDate(value, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }) + ' ' + t('bogota');
  return <main className="audit-shell portal-shell">
    <div className="audit-main">
      <div className="audit-heading"><span className="page-icon page-icon-violet" aria-hidden="true"><Icon name="partner" size={22} /></span><h1 className="audit-heading-text">{t('title')}</h1><a className="btn btn-secondary btn-small" href="/api/docs/?spec=v2/partner-portal"><Icon name="file" size={16} />{t('documentation')}</a></div>
      {state?.kind === 'forbidden' ? <AccessDenied message={t('forbidden')} traceId={'traceId' in state ? state.traceId : undefined} /> : <>
      <form className="card portal-period" noValidate onSubmit={event => {
        event.preventDefault();
        const found = dateRangeProblem(draft.from, draft.to, 31) ?? (!draft.from ? { field: 'from' as const, reason: 'invalid' as const } : !draft.to ? { field: 'to' as const, reason: 'invalid' as const } : null);
        setProblem(found);
        if (found) { document.getElementById(`portal-${found.field}`)?.focus(); return; }
        setResult(null); setPeriod({ ...draft }); setRefresh(v => v + 1);
      }}>
        {(['from', 'to'] as const).map(field => <div className="field" key={field}><label htmlFor={`portal-${field}`}>{t(field)}</label>
          <CalendarDateInput id={`portal-${field}`} required value={draft[field]} aria-invalid={problem?.field === field || undefined} aria-describedby={problem?.field === field ? 'portal-period-error' : undefined}
            onChange={value => { setDraft({ ...draft, [field]: value }); setProblem(null); }} />
          {problem?.field === field && <p className="field-error" id="portal-period-error" role="alert">{intl.formatMessage({ id: `form.range.${problem.reason}` }, { days: 31 })}</p>}</div>)}
        <button className="btn btn-primary" type="submit"><Icon name="search" size={16} />{t('apply')}</button>
        <p className="note">{t('periodHint')}</p>
      </form>
      {!page && <div className="audit-state" role={!state ? 'status' : 'alert'}><p>{t(state?.kind ?? 'loading')}</p>
        {state && state.kind !== 'unauthenticated' && state.kind !== 'invalid' && <button className="btn btn-secondary" type="button" onClick={() => { setResult(null); setRefresh(v => v + 1); }}>{t('retry')}</button>}
        {state && 'traceId' in state && state.traceId && <p className="mono">{state.traceId}</p>}
      </div>}
      {page && <>
        <div className="portal-context"><span className="pill pill-ok mono">{page.partner.code}</span><p className="note">{t('appliedPeriod')} {day(page.period.from)} – {day(page.period.to)} UTC</p><p className="note">{t('updated')} {timestamp(page.updatedAt)}</p></div>
        <section aria-labelledby="portal-metrics"><h2 id="portal-metrics" className="portal-section-title"><span className="icon-chip icon-chip-sm" aria-hidden="true"><Icon name="reports" size={16} /></span>{t('metrics')}</h2>
          <dl className="portal-metrics">{(['completed','accepted','preliminary','declined'] as const).map(k => <div key={k}><dt>{t(k)}</dt><dd className="mono">{intl.formatNumber(page.totals[k])}</dd></div>)}</dl>
        </section>
        <section aria-labelledby="portal-quota"><h2 id="portal-quota" className="portal-section-title"><span className="icon-chip icon-chip-sm icon-chip-amber" aria-hidden="true"><Icon name="gauge" size={16} /></span>{t('quota')}</h2>{page.quota.configured ? <><dl className="portal-metrics">{(['limit','used','remaining'] as const).map(k=><div key={k}><dt>{t(k)}</dt><dd className="mono">{intl.formatNumber(page.quota.configured ? page.quota[k] : 0)}</dd></div>)}</dl><p className="note">{t('quotaHint')}</p><p className="portal-reset icon-label"><Icon name="clock" size={16} />{t('resets')} {timestamp(page.quota.resetsAt)}</p><p className="note">{t('trackingSince')} {timestamp(page.quota.trackingSince)}</p><p className="note">{t('updated')} {timestamp(page.quota.updatedAt)}</p></> : <p>{t('notConfigured')}</p>}</section>
        <section aria-labelledby="portal-transactions"><h2 id="portal-transactions" className="portal-section-title"><span className="icon-chip icon-chip-sm icon-chip-blue" aria-hidden="true"><Icon name="claims" size={16} /></span>{t('transactions')}</h2>
          {page.items.length ? <div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table"><caption className="visually-hidden">{t('transactions')}</caption><thead><tr>{['reference','kind','date','result','rule'].map(k => <th key={k} scope="col">{t(k)}</th>)}</tr></thead>
            <tbody>{page.items.map(item => <tr key={item.kind + item.id}><td data-label={t('reference')} className="mono audit-id">{item.reference}</td><td data-label={t('kind')}>{t(item.kind)}</td><td data-label={t('date')}>{timestamp(item.occurredAt)}</td><td data-label={t('result')}><span className={`claims-badge portal-result-${item.result}`}>{t(`result.${item.result}`)}</span></td><td data-label={t('rule')} className="mono">{item.ruleVersion}</td></tr>)}</tbody></table></div> : <p role="status">{t('empty')}</p>}
          {page.hasMore && <p className="note">{t('recentLimit')}</p>}
        </section>
        <section aria-labelledby="portal-credentials"><h2 id="portal-credentials" className="portal-section-title"><span className="icon-chip icon-chip-sm icon-chip-violet" aria-hidden="true"><Icon name="key" size={16} /></span>{t('credentials')}</h2>
          {page.credentials.length ? <div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table"><caption className="visually-hidden">{t('credentials')}</caption><thead><tr>{['reference','scopes','expires','status'].map(k => <th key={k} scope="col">{t(k)}</th>)}</tr></thead><tbody>{page.credentials.map(c => <tr key={c.id}><td data-label={t('reference')} className="mono audit-id">{c.id}</td><td data-label={t('scopes')}>{c.scopes.join(', ')}</td><td data-label={t('expires')}>{timestamp(c.expiresAt)}</td><td data-label={t('status')}><span className={`pill ${c.status === 'active' ? 'pill-ok' : 'pill-status-expired'}`}>{t(c.status)}</span></td></tr>)}</tbody></table></div> : <p>{t('noCredentials')}</p>}
          {page.hasMoreCredentials && <p className="note">{t('credentialLimit')}</p>}
        </section>
        <section aria-labelledby="portal-catalog"><h2 id="portal-catalog" className="portal-section-title"><span className="icon-chip icon-chip-sm icon-chip-slate" aria-hidden="true"><Icon name="link" size={16} /></span>{t('catalog')}</h2><p className="portal-product">{t('mortgage')}</p><ul className="portal-operations">{page.catalog.flatMap(p => p.operations).map(o => <li key={o.path}><span className="portal-method">{o.method}</span><span className="mono">{o.path}</span><span className="pill pill-status-expired mono">{o.scope}</span></li>)}</ul></section>
        <section aria-labelledby="portal-versions"><h2 id="portal-versions" className="portal-section-title"><span className="icon-chip icon-chip-sm icon-chip-slate" aria-hidden="true"><Icon name="refresh" size={16} /></span>{t('versions')}</h2><ul className="portal-versions">{page.versions.map(v => <li key={v.id}><span className="portal-version mono">{v.id}</span><span className={`pill ${v.sunset ? 'pill-pending' : 'pill-ok'}`}>{v.sunset ? `${t('sunset')} ${intl.formatDate(v.sunset + 'T12:00:00Z', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : t('noSunset')}</span></li>)}</ul></section>
      </>}
      </>}
    </div>
  </main>;
}
