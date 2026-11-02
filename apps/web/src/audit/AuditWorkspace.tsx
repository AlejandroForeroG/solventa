import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { getAuditDecision, listAuditDecisions, type AuditDetail, type AuditOutcome, type AuditPage } from './api';
import './audit.css';

type Data = { kind: 'page'; page: AuditPage } | { kind: 'detail'; detail: AuditDetail };
type State = { kind: 'loading' | 'hidden' } | { kind: 'ready'; data: Data } | Exclude<AuditOutcome<never>, { kind: 'ok' }>;
export function AuditWorkspace({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const format = useFormatters();
  const t = (key: string) => intl.formatMessage({ id: `audit.${key}`, defaultMessage: key });
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    request.current = abort;
    setNotice(''); setExporting(false);
    if (document.hidden) { setState({ kind: 'hidden' }); return () => { abort.abort(); generation.current++; }; }
    setState({ kind: 'loading' });
    void (selection ? getAuditDecision(selection, abort.signal).then(result => result.kind === 'ok' ? { kind: 'ok' as const, value: { kind: 'detail' as const, detail: result.value } } : result)
      : listAuditDecisions(new URLSearchParams(query), abort.signal).then(result => result.kind === 'ok' ? { kind: 'ok' as const, value: { kind: 'page' as const, page: result.value } } : result))
      .then(result => {
        if (current !== generation.current || abort.signal.aborted) return;
        if (result.kind === 'unauthenticated') onSessionLost();
        setState(result.kind === 'ok' ? { kind: 'ready', data: result.value } : result);
        heading.current?.focus();
      }).catch(() => { if (current === generation.current && !abort.signal.aborted) setState({ kind: 'unavailable' }); });
    return () => { generation.current++; abort.abort(); };
  }, [selection, query, refresh, onSessionLost]);
  useEffect(() => {
    const reload = () => { request.current?.abort(); generation.current++; setState({ kind: document.hidden ? 'hidden' : 'loading' }); setRefresh(value => value + 1); };
    document.addEventListener('visibilitychange', reload);
    window.addEventListener('focus', reload);
    const timer = setInterval(() => { if (!document.hidden) reload(); }, 60000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', reload); window.removeEventListener('focus', reload); };
  }, []);
  async function download(id: string) {
    const current = generation.current;
    const signal = request.current?.signal;
    if (!signal || signal.aborted) return;
    setExporting(true); setNotice('');
    try {
      const result = await getAuditDecision(id, signal);
      if (current !== generation.current || signal.aborted || document.hidden) return;
      if (result.kind !== 'ok') {
        setState(result); if (result.kind === 'unauthenticated') onSessionLost(); return;
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `underwriting-${id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('exported');
    } catch { if (current === generation.current && !signal.aborted) setNotice('unavailable'); }
    finally { if (current === generation.current) setExporting(false); }
  }
  const detail = state.kind === 'ready' && state.data.kind === 'detail' ? state.data.detail : null;
  const page = state.kind === 'ready' && state.data.kind === 'page' ? state.data.page : null;
  return <main className="audit-shell">
    <aside className="audit-nav" aria-label={t('console')}><p>{t('console')}</p><a href="/auditoria" aria-current="page">{t('open')}</a></aside>
    <div className="audit-main">
      {selection && <button className="audit-back" type="button" onClick={() => { setSelection(null); setNotice(''); }}>{'← ' + t('back')}</button>}
      <div className="audit-heading"><div><p className="section-label">{t('open')}</p><h1 ref={heading} tabIndex={-1}>{t(selection ? 'decision' : 'title')}</h1>{detail && <p className="mono audit-id">{detail.decisionId}</p>}<p className="note audit-mode">{t('simulated')}</p></div>
        {detail && <button className="btn btn-secondary" type="button" disabled={exporting} onClick={() => void download(detail.decisionId)}>{t(exporting ? 'exporting' : 'export')}</button>}
      </div>
      {!selection && <form className="audit-filters" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget); const params = new URLSearchParams();
        for (const [key, value] of data) if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
        setQuery(params.toString()); setRefresh(value => value + 1);
      }}>
        <div className="field audit-reference"><label htmlFor="audit-reference">{t('reference')}</label><input id="audit-reference" name="reference" defaultValue={new URLSearchParams(query).get('reference') ?? ''} maxLength={64} autoComplete="off" /></div>
        <div className="field"><label htmlFor="audit-product">{t('product')}</label><select id="audit-product" name="product" defaultValue={new URLSearchParams(query).get('product') ?? ''}><option value="">{t('all')}</option>{['vida_hipotecario', 'flight_delay'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></div>
        <div className="field"><label htmlFor="audit-outcome">{t('outcome')}</label><select id="audit-outcome" name="outcome" defaultValue={new URLSearchParams(query).get('outcome') ?? ''}><option value="">{t('all')}</option>{['accepted', 'declined', 'preliminary'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></div>
        {['from', 'to'].map(key => <div className="field" key={key}><label htmlFor={`audit-${key}`}>{t(key)}</label><input type="date" id={`audit-${key}`} name={key} defaultValue={new URLSearchParams(query).get(key) ?? ''} /></div>)}
        <div className="audit-filter-actions"><button className="btn btn-primary" type="submit">{t('search')}</button><button className="btn btn-secondary" type="reset" onClick={() => { setQuery(''); setRefresh(value => value + 1); }}>{t('reset')}</button></div>
      </form>}
      {state.kind !== 'ready' && <div className={`audit-state ${state.kind === 'forbidden' ? 'audit-denied' : ''}`} role={state.kind === 'loading' || state.kind === 'hidden' ? 'status' : 'alert'}>
        <p>{t(state.kind)}</p>{state.kind !== 'loading' && state.kind !== 'hidden' && state.kind !== 'unauthenticated' && <button type="button" className="btn btn-secondary" onClick={() => setRefresh(value => value + 1)}>{t('retry')}</button>}
        {'traceId' in state && state.traceId && <p className="mono audit-id">{state.traceId}</p>}
      </div>}
      {page && (page.items.length ? <><div className="audit-table-wrap"><table className="audit-table"><caption className="visually-hidden">{t('title')}</caption><thead><tr>{['decision', 'product', 'outcome', 'rule', 'date'].map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead><tbody>
        {page.items.map(item => <tr key={item.decisionId}><td><button type="button" className="audit-link mono" onClick={() => setSelection(item.decisionId)}>{item.decisionId}</button>{item.quoteId && <span className="audit-secondary mono">{item.quoteId}</span>}</td><td>{item.product ? t(item.product) : t('unknown')}</td><td><span className={`audit-outcome audit-${item.outcome}`}>{t(item.outcome)}</span></td><td className="mono">{item.ruleVersion}</td><td>{format.dateTime(new Date(item.decidedAt))}</td></tr>)}
      </tbody></table></div>{page.next && <div className="audit-pagination"><button className="btn btn-secondary" type="button" onClick={() => { const params = new URLSearchParams(query); params.set('before', page.next ?? ''); setQuery(params.toString()); }}>{t('next')}</button></div>}</> : <div className="audit-state" role="status">{t('empty')}</div>)}
      {detail && <>
        <dl className="audit-metadata"><div><dt>{t('outcome')}</dt><dd><span className={`audit-outcome audit-${detail.outcome}`}>{t(detail.outcome)}</span></dd></div><div><dt>{t('date')}</dt><dd>{format.dateTime(new Date(detail.decidedAt))}</dd></div><div><dt>{t('product')}</dt><dd>{detail.product ? t(detail.product) : t('unknown')}</dd></div><div><dt>{t('quote')}</dt><dd className="mono">{detail.quoteId ?? '—'}</dd></div></dl>
        <section className="audit-section"><h2>{t('reconstruction')}</h2><p className={detail.reconstruction.status === 'reconstructed' ? 'audit-match' : 'audit-warning'}>{t(detail.reconstruction.status)}</p><p className="note">{t('consistencyOnly')}</p>{detail.reconstruction.checks && <dl className="audit-facts audit-checks">{Object.entries(detail.reconstruction.checks).map(([key, value]) => <div key={key}><dt>{t(`check.${key}`)}</dt><dd>{t(value ? 'yes' : 'no')}</dd></div>)}</dl>}
          {detail.reconstruction.missing.length > 0 && <div><h3>{t('missing')}</h3><ul>{detail.reconstruction.missing.map(key => <li key={key}>{t(`input.${key.replace('inputs.', '')}`)}</li>)}</ul></div>}
        </section>
        <section className="audit-section"><h2>{t('inputs')}</h2><dl className="audit-facts">{Object.entries(detail.inputs).map(([key, value]) => <div key={key}><dt>{t(`input.${key}`)}</dt><dd>{typeof value === 'boolean' ? t(value ? 'yes' : 'no') : typeof value === 'number' ? intl.formatNumber(value) : value}</dd></div>)}</dl>{!Object.keys(detail.inputs).length && <p>{t('unknown')}</p>}</section>
        <section className="audit-section"><h2>{t('sources')}</h2>{detail.sources.length ? <div className="audit-table-wrap"><table className="audit-table"><thead><tr>{['source', 'quality', 'captured', 'degraded', 'confidence'].map(key => <th scope="col" key={key}>{t(key)}</th>)}</tr></thead><tbody>{detail.sources.map((source, index) => <tr key={index}><td className="mono">{source.source}</td><td>{t(source.quality)}</td><td>{format.dateTime(new Date(source.capturedAt))}</td><td>{t(source.degraded ? 'yes' : 'no')}{source.failure && <span className="audit-secondary">{source.failure}</span>}</td><td>{source.confidence !== undefined ? intl.formatNumber(source.confidence / 100, { style: 'percent' }) : '—'}</td></tr>)}</tbody></table></div> : <p>{t('unknown')}</p>}</section>
        <div className="audit-two-columns"><section className="audit-section"><h2>{t('rule')}</h2><dl className="audit-facts"><div><dt>{t('rule')}</dt><dd className="mono">{detail.rule?.id ?? t('unknown')}</dd></div><div><dt>{t('version')}</dt><dd className="mono">{detail.ruleVersion}</dd></div><div><dt>{t('model')}</dt><dd>{t(detail.model.status)}{detail.model.id && <span className="audit-secondary mono">{detail.model.id} / {detail.model.version}</span>}</dd></div></dl></section>
          <section className="audit-section"><h2>{t('consent')}</h2><p>{detail.consent ? t(detail.consent.status) : t('unknown')}</p>{detail.consent?.id && <p className="mono">{detail.consent.id} / {detail.consent.version}</p>}<p className="note">{t('historicalConsent')}</p></section></div>
        <section className="audit-section"><h2>{t('revisions')}</h2>{detail.revisions.length ? <div className="audit-table-wrap"><table className="audit-table"><thead><tr>{['decision', 'version', 'premium'].map(key => <th key={key} scope="col">{t(key === 'decision' ? 'offer' : key)}</th>)}</tr></thead><tbody>{detail.revisions.map(revision => <tr key={`${revision.offerId}-${revision.version}`}><td className="mono">{revision.offerId}{revision.flightReference && <span className="audit-secondary">{t('flightReference')}: {revision.flightReference}</span>}</td><td>{revision.version}</td><td>{revision.currency === 'COP' ? format.copDecimal(revision.premium) : `${revision.premium} ${revision.currency}`}</td></tr>)}</tbody></table></div> : <p>—</p>}</section>
        <p className="note audit-id">{t('trace')}: <span className="mono">{detail.correlationId}</span></p>
      </>}
      <p role="status" className="note">{notice && t(notice)}</p>
    </div>
  </main>;
}
