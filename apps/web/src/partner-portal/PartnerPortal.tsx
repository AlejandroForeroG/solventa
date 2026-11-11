import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { readPartnerPortal, type PortalOutcome } from './api';
import '../audit/audit.css';
import './portal.css';

export function PartnerPortal({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `partnerPortal.${key}` });
  const [period, setPeriod] = useState(() => ({ from: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }));
  const [draft, setDraft] = useState(period);
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
  const timestamp = (value: string) => intl.formatDate(value, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  return <main className="audit-shell portal-shell">
    <aside className="audit-nav" aria-label={t('title')}><p>{t('title')}</p><a href="/socios" aria-current="page">{t('overview')}</a><a href="/api/docs/?spec=v1/partner-portal">{t('documentation')}</a></aside>
    <div className="audit-main">
      <div className="audit-heading"><h1>{t('title')}</h1></div>
      <form className="portal-period" onSubmit={event => { event.preventDefault(); setResult(null); setPeriod({ ...draft }); setRefresh(v => v + 1); }}>
        <label className="field">{t('from')}<input type="date" required value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
        <label className="field">{t('to')}<input type="date" required value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
        <button className="btn btn-secondary" type="submit">{t('apply')}</button>
        <p className="note">{t('periodHint')}</p>
      </form>
      {!page && <div className="audit-state" role={!state ? 'status' : 'alert'}><p>{t(state?.kind ?? 'loading')}</p>
        {state && state.kind !== 'unauthenticated' && <button className="btn btn-secondary" type="button" onClick={() => { setResult(null); setRefresh(v => v + 1); }}>{t('retry')}</button>}
        {state && 'traceId' in state && state.traceId && <p className="mono">{state.traceId}</p>}
      </div>}
      {page && <>
        <p className="mono">{page.partner.code}</p><p className="note">{t('appliedPeriod')} {page.period.from} – {page.period.to} UTC</p><p className="note">{t('updated')} {timestamp(page.updatedAt)}</p>
        <section aria-labelledby="portal-metrics"><h2 id="portal-metrics">{t('metrics')}</h2>
          <dl className="portal-metrics">{(['completed','accepted','preliminary','declined'] as const).map(k => <div key={k}><dt>{t(k)}</dt><dd className="mono">{intl.formatNumber(page.totals[k])}</dd></div>)}</dl>
          <p className="note">{t('metricLimit')}</p>
        </section>
        <section aria-labelledby="portal-transactions"><h2 id="portal-transactions">{t('transactions')}</h2>
          {page.items.length ? <div className="audit-table-wrap"><table className="audit-table"><caption className="visually-hidden">{t('transactions')}</caption><thead><tr>{['reference','kind','date','result','rule'].map(k => <th key={k} scope="col">{t(k)}</th>)}</tr></thead>
            <tbody>{page.items.map(item => <tr key={item.kind + item.id}><td className="mono audit-id">{item.reference}</td><td>{t(item.kind)}</td><td>{timestamp(item.occurredAt)}</td><td>{t(item.result)}</td><td className="mono">{item.ruleVersion}</td></tr>)}</tbody></table></div> : <p role="status">{t('empty')}</p>}
          {page.hasMore && <p className="note">{t('recentLimit')}</p>}
        </section>
        <section aria-labelledby="portal-credentials"><h2 id="portal-credentials">{t('credentials')}</h2>
          <p className="note">{t('credentialHint')}</p>
          {page.credentials.length ? <div className="audit-table-wrap"><table className="audit-table"><caption className="visually-hidden">{t('credentials')}</caption><thead><tr>{['reference','scopes','expires','status'].map(k => <th key={k} scope="col">{t(k)}</th>)}</tr></thead><tbody>{page.credentials.map(c => <tr key={c.id}><td className="mono audit-id">{c.id}</td><td>{c.scopes.join(', ')}</td><td>{timestamp(c.expiresAt)}</td><td>{t(c.status)}</td></tr>)}</tbody></table></div> : <p>{t('noCredentials')}</p>}
          {page.hasMoreCredentials && <p className="note">{t('credentialLimit')}</p>}
        </section>
        <section aria-labelledby="portal-catalog"><h2 id="portal-catalog">{t('catalog')}</h2><p>{t('mortgage')}</p><ul>{page.catalog.flatMap(p => p.operations).map(o => <li className="mono" key={o.path}>{o.method} {o.path} · {o.scope}</li>)}</ul></section>
        <section aria-labelledby="portal-quota"><h2 id="portal-quota">{t('quota')}</h2><p>{t('notConfigured')}</p></section>
        <section aria-labelledby="portal-versions"><h2 id="portal-versions">{t('versions')}</h2><ul>{page.versions.map(v => <li key={v.id}><span className="mono">{v.id}</span> · {v.sunset ? `${t('sunset')} ${v.sunset}` : t('noSunset')}</li>)}</ul><p className="note">{t('versionHint')}</p></section>
      </>}
    </div>
  </main>;
}
