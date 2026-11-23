import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { CalendarDateInput } from '../forms/CalendarDateInput';
import { dateRangeProblem, type DateRangeProblem } from '../forms/date-range';
import { getAuditDecision, listAuditDecisions, type AuditDetail, type AuditOutcome, type AuditPage } from './api';
import { AccessDenied } from '../navigation/AccessDenied';
import './audit.css';
import { Icon } from '../navigation/Icon';

const sourceLabels: Record<string, string> = { 'signal:income_obligations_12m': 'income', 'signal:payment_history_score': 'payments', 'signal:affiliation_regime': 'affiliation', 'signal:identity_validation': 'identity' };

const emptyFilters = () => ({ reference: '', product: '', outcome: '', from: '', to: '' });
type Data = { kind: 'page'; page: AuditPage } | { kind: 'detail'; detail: AuditDetail };
type State = { kind: 'loading' | 'hidden' } | { kind: 'ready'; data: Data } | Exclude<AuditOutcome<never>, { kind: 'ok' }>;
export function AuditWorkspace({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const format = useFormatters();
  const t = (key: string, values?: Record<string, number>) => intl.formatMessage({ id: `audit.${key}`, defaultMessage: key }, values);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(emptyFilters);
  const [rangeProblem, setRangeProblem] = useState<DateRangeProblem>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [visibleCount, setVisibleCount] = useState(5);
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const revealFocus = useRef<string | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (revealFocus.current) document.getElementById(revealFocus.current)?.focus();
    revealFocus.current = null;
  }, [visibleCount]);
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
  const nextPage = () => { if (!page?.next) return; const params = new URLSearchParams(query); params.set('before', page.next); setPageHistory(history => [...history, query]); setVisibleCount(5); setQuery(params.toString()); };
  const previousPage = () => { const previous = pageHistory.at(-1); if (previous === undefined) return; setPageHistory(history => history.slice(0, -1)); setVisibleCount(5); setQuery(previous); };
  return <main className="audit-shell">
    <div className="audit-main">
      {selection && <button className="audit-back" type="button" onClick={() => { setSelection(null); setNotice(''); }}><Icon name="back" size={16} />{t('back')}</button>}
      <div className="audit-heading"><span className="page-icon page-icon-green" aria-hidden="true"><Icon name="audit" size={22} /></span><div className="audit-heading-text"><p className="section-label">{t('open')}</p><h1 ref={heading} tabIndex={-1}>{t(selection ? 'decision' : 'title')}</h1>{detail && <><p className="mono audit-id">{detail.quoteId ?? detail.decisionId}</p>{detail.quoteId && <details className="audit-reference-details"><summary>{t('technicalReference')}</summary><span className="mono">{detail.decisionId}</span></details>}</>}<p className="note audit-mode">{t('simulated')}</p></div>
        {detail && <button className="btn btn-secondary" type="button" disabled={exporting} onClick={() => void download(detail.decisionId)}>{t(exporting ? 'exporting' : 'export')}</button>}
      </div>
      {state.kind === 'forbidden' ? <AccessDenied message={t('forbidden')} traceId={'traceId' in state ? state.traceId : undefined} /> : <>
      {!selection && <form className="audit-filters" onReset={event => {
        event.preventDefault(); setRangeProblem(null); setFilters(emptyFilters()); setPageHistory([]); setQuery(''); setVisibleCount(5); setRefresh(value => value + 1);
      }} onSubmit={event => {
        event.preventDefault();
        const found = dateRangeProblem(filters.from.trim(), filters.to.trim());
        setRangeProblem(found);
        if (found) { document.getElementById(`audit-${found.field}`)?.focus(); return; }
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
        setPageHistory([]); setQuery(params.toString()); setVisibleCount(5); setRefresh(value => value + 1);
      }}>
        <div className="field audit-reference"><label htmlFor="audit-reference">{t('reference')}</label><input id="audit-reference" name="reference" value={filters.reference} onChange={event => setFilters(current => ({ ...current, reference: event.target.value }))} maxLength={64} autoComplete="off" /></div>
        <div className="field"><label htmlFor="audit-product">{t('product')}</label><select id="audit-product" name="product" value={filters.product} onChange={event => setFilters(current => ({ ...current, product: event.target.value }))}><option value="">{t('all')}</option>{['vida_hipotecario', 'flight_delay'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></div>
        <div className="field"><label htmlFor="audit-outcome">{t('outcome')}</label><select id="audit-outcome" name="outcome" value={filters.outcome} onChange={event => setFilters(current => ({ ...current, outcome: event.target.value }))}><option value="">{t('all')}</option>{['accepted', 'declined', 'preliminary'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></div>
        {(['from', 'to'] as const).map(key => <div className="field" key={key}><label htmlFor={`audit-${key}`}>{t(key)}</label><CalendarDateInput id={`audit-${key}`} name={key} value={filters[key]} aria-invalid={rangeProblem?.field === key || undefined} aria-describedby={rangeProblem?.field === key ? 'audit-range-error' : undefined}
          onChange={value => { setFilters(current => ({ ...current, [key]: value })); setRangeProblem(null); }} />
          {rangeProblem?.field === key && <p className="field-error" id="audit-range-error" role="alert">{intl.formatMessage({ id: `form.range.${rangeProblem.reason}` }, { days: 31 })}</p>}</div>)}
        <div className="audit-filter-actions"><button className="btn btn-primary" type="submit">{t('search')}</button><button className="btn btn-secondary" type="reset">{t('reset')}</button></div>
      </form>}
      {state.kind !== 'ready' && <div className="audit-state" role={state.kind === 'loading' || state.kind === 'hidden' ? 'status' : 'alert'}>
        <p>{t(state.kind)}</p>{state.kind !== 'loading' && state.kind !== 'hidden' && state.kind !== 'unauthenticated' && state.kind !== 'invalid' && <button type="button" className="btn btn-secondary" onClick={() => setRefresh(value => value + 1)}>{t('retry')}</button>}
        {'traceId' in state && state.traceId && <p className="mono audit-id">{state.traceId}</p>}
      </div>}
      {page && (page.items.length ? <><p className="note" role="status">{t('showingPage', { count: Math.min(visibleCount, page.items.length), total: page.items.length })}</p><div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table"><caption className="visually-hidden">{t('title')}</caption><thead><tr>{['decision', 'product', 'outcome', 'rule', 'date'].map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead><tbody>
        {page.items.slice(0, visibleCount).map(item => <tr key={item.decisionId} className={`compact-record ${expanded[item.decisionId] ? 'record-expanded' : ''}`}><td data-label={t('decision')}><div><button type="button" id={`audit-decision-${item.decisionId}`} className="audit-link mono" aria-label={`${t('decision')}: ${item.quoteId ?? item.decisionId} · DEC-${item.decisionId.slice(0, 8).toUpperCase()}`} onClick={() => setSelection(item.decisionId)}>DEC-{item.decisionId.slice(0, 8).toUpperCase()}</button>{item.quoteId && <span className="audit-secondary">{item.quoteId}</span>}<button type="button" className="record-toggle"
          aria-expanded={!!expanded[item.decisionId]} aria-label={`${t(expanded[item.decisionId] ? 'hideDetails' : 'details')}: ${item.quoteId ?? item.decisionId.slice(0, 8)}`}
          aria-controls={`audit-rule-${item.decisionId} audit-date-${item.decisionId} audit-reference-${item.decisionId}`}
          onClick={() => setExpanded(current => ({ ...current, [item.decisionId]: !current[item.decisionId] }))}>{t(expanded[item.decisionId] ? 'hideDetails' : 'details')}</button><details id={`audit-reference-${item.decisionId}`} data-secondary className="audit-reference-details"><summary>{t('technicalReference')}</summary><span className="mono">{item.decisionId}</span></details></div></td><td data-label={t('product')}>{item.product ? t(item.product) : t('unknown')}</td><td data-label={t('outcome')}><span className={`audit-outcome audit-${item.outcome}`}>{t(item.outcome)}</span></td><td id={`audit-rule-${item.decisionId}`} data-secondary data-label={t('rule')} className="mono">{item.ruleVersion}</td><td id={`audit-date-${item.decisionId}`} data-secondary data-label={t('date')}>{format.dateTime(new Date(item.decidedAt))}</td></tr>)}
      </tbody></table></div>{visibleCount < page.items.length && <div className="audit-pagination"><button className="btn btn-secondary" type="button" onClick={() => { revealFocus.current = `audit-decision-${page.items[visibleCount].decisionId}`; setVisibleCount(count => count + 5); }}>{t('showMore')}</button></div>}{(pageHistory.length > 0 || (page.next && visibleCount >= page.items.length)) && <nav className="audit-pagination" aria-label={t('pagination')}>
        {pageHistory.length > 0 && <button className="btn btn-secondary" type="button" onClick={previousPage}>{t('previous')}</button>}
        {page.next && visibleCount >= page.items.length && <button className="btn btn-secondary" type="button" onClick={nextPage}>{t('next')}</button>}</nav>}</> : <div className="audit-state" role="status">{t('empty')}</div>)}
      {detail && <>
        <nav className="audit-section-links" aria-label={t('sections')}>
          {['reconstruction', 'inputs', 'sources', 'rule', 'consent', 'revisions'].map(section => <a key={section} href={`#audit-${section}`} onClick={() => {
            const target = document.getElementById(`audit-${section}`);
            const disclosure = target?.querySelector('details.audit-disclosure');
            if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
            target?.focus({ preventScroll: true });
          }}>{t(section)}</a>)}
        </nav>
        <dl className="audit-metadata"><div><dt>{t('outcome')}</dt><dd><span className={`audit-outcome audit-${detail.outcome}`}>{t(detail.outcome)}</span></dd></div><div><dt>{t('date')}</dt><dd>{format.dateTime(new Date(detail.decidedAt))}</dd></div><div><dt>{t('product')}</dt><dd>{detail.product ? t(detail.product) : t('unknown')}</dd></div><div><dt>{t('quote')}</dt><dd className="mono">{detail.quoteId ?? '—'}</dd></div></dl>
        <section id="audit-reconstruction" tabIndex={-1} className="audit-section"><h2>{t('reconstruction')}</h2><p className={detail.reconstruction.status === 'reconstructed' ? 'audit-match' : 'audit-warning'}>{t(detail.reconstruction.status)}</p><p className="note">{t('consistencyOnly')}</p>{detail.reconstruction.checks && <dl className="audit-facts audit-checks">{Object.entries(detail.reconstruction.checks).map(([key, value]) => <div key={key}><dt>{t(`check.${key}`)}</dt><dd>{t(value ? 'yes' : 'no')}</dd></div>)}</dl>}
          {detail.reconstruction.missing.length > 0 && <div><h3>{t('missing')}</h3><ul>{detail.reconstruction.missing.map(key => <li key={key}>{t(`input.${key.replace('inputs.', '')}`)}</li>)}</ul></div>}
        </section>
        <section id="audit-inputs" tabIndex={-1} className="audit-section"><details className="audit-disclosure"><summary><h2>{t('inputs')}</h2></summary>{Object.keys(detail.inputs).some(key => key.endsWith('Ppm')) && <p className="note">{t('ppmHint')}</p>}<dl className="audit-facts">{Object.entries(detail.inputs).map(([key, value]) => <div key={key}><dt>{t(`input.${key}`)}</dt><dd>{typeof value === 'boolean' ? t(value ? 'yes' : 'no') : typeof value === 'number' ? intl.formatNumber(value) : value}</dd></div>)}</dl>{!Object.keys(detail.inputs).length && <p>{t('unknown')}</p>}
          {!!detail.inputEvidence?.length && <div><h3>{t('inputEvidence')}</h3><div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table"><thead><tr>{['inputField', 'source', 'evidenceReference', 'version'].map(key => <th scope="col" key={key}>{t(key)}</th>)}</tr></thead><tbody>{detail.inputEvidence.map(evidence => <tr key={evidence.field}><td data-label={t('inputField')}>{t(`input.${evidence.field.replace('inputs.', '')}`)}</td><td data-label={t('source')}>{t(`evidence.${evidence.kind}`)}</td><td data-label={t('evidenceReference')} className="mono audit-id">{evidence.reference}</td><td data-label={t('version')} className="mono audit-id">{evidence.version}</td></tr>)}</tbody></table></div></div>}
        </details></section>
        <section id="audit-sources" tabIndex={-1} className="audit-section"><details className="audit-disclosure"><summary><h2>{t('sources')}</h2></summary>{detail.sources.length ? <div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table"><thead><tr>{['source', 'quality', 'captured', 'degraded', 'confidence'].map(key => <th scope="col" key={key}>{t(key)}</th>)}</tr></thead><tbody>{detail.sources.map((source, index) => <tr key={index}><td data-label={t('source')}><div>{Object.hasOwn(sourceLabels, source.source) ? <><span>{t(`sourceName.${sourceLabels[source.source]}`)}</span><details className="audit-reference-details"><summary>{t('sourceKey')}</summary><span className="mono">{source.source}</span></details></> : <span className="mono">{source.source}</span>}</div></td><td data-label={t('quality')}>{t(source.quality)}</td><td data-label={t('captured')}>{format.dateTime(new Date(source.capturedAt))}</td><td data-label={t('degraded')}>{t(source.degraded ? 'yes' : 'no')}{source.failure && <span className="audit-secondary">{source.failure}</span>}</td><td data-label={t('confidence')}>{source.confidence !== undefined ? intl.formatNumber(source.confidence / 100, { style: 'percent' }) : '—'}</td></tr>)}</tbody></table></div> : <p>{t('unknown')}</p>}</details></section>
        <div className="audit-two-columns"><section id="audit-rule" tabIndex={-1} className="audit-section"><h2>{t('rule')}</h2><dl className="audit-facts"><div><dt>{t('rule')}</dt><dd className="mono">{detail.rule?.id ?? t('unknown')}</dd></div><div><dt>{t('version')}</dt><dd className="mono">{detail.ruleVersion}</dd></div><div><dt>{t('model')}</dt><dd>{t(detail.model.status)}{detail.model.id && <span className="audit-secondary mono">{detail.model.id} / {detail.model.version}</span>}</dd></div></dl></section>
          <section id="audit-consent" tabIndex={-1} className="audit-section"><h2>{t('consent')}</h2><p>{detail.consent ? t(detail.consent.status) : t('unknown')}</p>{detail.consent?.id && <p className="mono">{detail.consent.id} / {detail.consent.version}</p>}<p className="note">{t('historicalConsent')}</p></section></div>
        <section id="audit-revisions" tabIndex={-1} className="audit-section"><h2>{t('revisions')}</h2>{detail.revisions.length ? <div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table"><thead><tr>{['decision', 'version', 'premium'].map(key => <th key={key} scope="col">{t(key === 'decision' ? 'offer' : key)}</th>)}</tr></thead><tbody>{detail.revisions.map(revision => <tr key={`${revision.offerId}-${revision.version}`}><td data-label={t('offer')} className="mono">{revision.offerId}{revision.flightReference && <span className="audit-secondary">{t('flightReference')}: {revision.flightReference}</span>}</td><td data-label={t('version')}>{revision.version}</td><td data-label={t('premium')}>{revision.currency === 'COP' ? format.copDecimal(revision.premium) : `${revision.premium} ${revision.currency}`}</td></tr>)}</tbody></table></div> : <p>—</p>}</section>
        <p className="note audit-id">{t('trace')}: <span className="mono">{detail.correlationId}</span></p>
      </>}
      </>}
      <p role="status" className="note">{notice && t(notice)}</p>
    </div>
  </main>;
}
