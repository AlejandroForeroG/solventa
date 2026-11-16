import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { listClaims, type ClaimsOutcome, type ClaimsPage } from './api';
import '../audit/audit.css';
import './claims.css';

type Filter = 'all' | 'unassigned' | 'pending_information' | 'overdue';
const FILTERS: readonly Filter[] = ['all', 'unassigned', 'pending_information', 'overdue'];
const SEARCH = /^(?:SIN-\d{4}-\d{5}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
type State = { kind: 'loading' | 'hidden' } | { kind: 'ready'; page: ClaimsPage } | Exclude<ClaimsOutcome<never>, { kind: 'ok' }>;

function criteria(filter: Filter, search: string, before?: string) {
  const params = new URLSearchParams();
  if (filter === 'unassigned' || filter === 'pending_information') params.set('state', filter);
  if (filter === 'overdue') params.set('overdue', 'true');
  if (search) params.set('query', search);
  if (before) params.set('before', before);
  return params;
}

export function ClaimsInbox({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const format = useFormatters();
  const t = (key: string, values?: Record<string, string | number>) => intl.formatMessage({ id: `claims.${key}`, defaultMessage: key }, values);
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [before, setBefore] = useState<string | undefined>();
  const [searchInvalid, setSearchInvalid] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ view: string; state: State } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(true);
  const view = [filter, search, before ?? ''].join('|');
  useEffect(() => {
    if (document.hidden) return;
    const abort = new AbortController();
    void listClaims(criteria(filter, search, before), abort.signal).then(outcome => {
      if (abort.signal.aborted) return;
      if (outcome.kind === 'unauthenticated') onSessionLost();
      if (outcome.kind === 'ok') setUpdatedAt(new Date());
      setResult({ view, state: outcome.kind === 'ok' ? { kind: 'ready', page: outcome.value } : outcome });
      if (moveFocus.current) { moveFocus.current = false; heading.current?.focus(); }
    }).catch(() => { if (!abort.signal.aborted) setResult({ view, state: { kind: 'unavailable' } }); });
    return () => abort.abort();
  }, [view, filter, search, before, refresh, onSessionLost]);
  useEffect(() => {
    const reload = () => setRefresh(value => value + 1);
    document.addEventListener('visibilitychange', reload);
    window.addEventListener('focus', reload);
    const timer = setInterval(() => { if (!document.hidden) reload(); }, 60000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', reload); window.removeEventListener('focus', reload); };
  }, []);
  const state: State = result?.view === view ? result.state : { kind: document.hidden ? 'hidden' : 'loading' };
  const choose = (next: Filter) => { moveFocus.current = true; setFilter(next); setBefore(undefined); };
  const clear = () => { moveFocus.current = true; setFilter('all'); setDraft(''); setSearch(''); setSearchInvalid(false); setBefore(undefined); };
  const page = state.kind === 'ready' ? state.page : null;
  const filtered = filter !== 'all' || search !== '';
  return <main className="audit-shell">
    <aside className="audit-nav" aria-label={t('console')}><p>{t('console')}</p>
      <a href="/siniestros" aria-current="page">{t('nav')}</a>
      <a href="/auditoria">{intl.formatMessage({ id: 'audit.open' })}</a>
    </aside>
    <div className="audit-main">
      <div className="audit-heading"><div><p className="section-label">{t('console')}</p><h1 ref={heading} tabIndex={-1}>{t('title')}</h1><p className="note audit-mode">{t('subtitle')}</p></div></div>
      <div className="claims-toolbar">
        <div role="group" aria-label={t('filterGroup')} className="claims-filters">
          {FILTERS.map(option => <button key={option} type="button" className="claims-filter" aria-pressed={filter === option} onClick={() => choose(option)}>{t(`filter.${option}`)}</button>)}
        </div>
        <form className="claims-search" onSubmit={event => {
          event.preventDefault();
          const value = draft.trim();
          if (value && !SEARCH.test(value)) { setSearchInvalid(true); return; }
          moveFocus.current = true; setSearchInvalid(false); setSearch(value.toLowerCase().startsWith('sin-') ? value.toUpperCase() : value.toLowerCase()); setBefore(undefined);
        }}>
          <label htmlFor="claims-search" className="visually-hidden">{t('search')}</label>
          <input id="claims-search" name="query" value={draft} onChange={event => setDraft(event.target.value)} placeholder={t('search')} maxLength={64} autoComplete="off"
            aria-invalid={searchInvalid} aria-describedby={searchInvalid ? 'claims-search-error' : undefined} />
          <button className="btn btn-secondary" type="submit">{t('searchButton')}</button>
        </form>
      </div>
      {searchInvalid && <p id="claims-search-error" className="claims-error" role="alert">{t('searchInvalid')}</p>}
      {state.kind !== 'ready' && <div className={`audit-state ${state.kind === 'forbidden' ? 'audit-denied' : ''}`} role={state.kind === 'loading' || state.kind === 'hidden' ? 'status' : 'alert'}>
        <p>{t(state.kind)}</p>{state.kind !== 'loading' && state.kind !== 'hidden' && state.kind !== 'unauthenticated' && <button type="button" className="btn btn-secondary" onClick={() => { moveFocus.current = true; setResult(null); setRefresh(value => value + 1); }}>{t('retry')}</button>}
        {'traceId' in state && state.traceId && <p className="mono audit-id">{state.traceId}</p>}
      </div>}
      {page && (page.items.length ? <>
        <div className="audit-table-wrap"><table className="audit-table claims-table"><caption className="visually-hidden">{t('title')}</caption>
          <thead><tr>{['claim', 'policy', 'state', 'age', 'amount', 'evidence', 'priority'].map(key => <th key={key} scope="col" className={key === 'amount' ? 'claims-amount' : undefined}>{t(`col.${key}`)}</th>)}</tr></thead>
          <tbody>{page.items.map(item => <tr key={item.claimId}>
            <td className="mono claims-number"><a href={'/siniestros/' + item.claimId}>{item.claimNumber}</a></td>
            <td className="mono audit-id">{item.policyId}</td>
            <td><span className={`claims-badge claims-state-${item.state}`}>{t(`state.${item.state}`)}</span></td>
            <td className={`mono ${item.overdue ? 'claims-overdue' : ''}`}>{t('age', { days: item.ageDays })}</td>
            <td className="mono claims-amount">{item.estimatedAmount === null ? t('amountPending') : item.currency === 'COP' ? format.copDecimal(item.estimatedAmount) : `${item.estimatedAmount} ${item.currency}`}</td>
            <td>{t('evidence', { provided: item.evidence.provided, required: item.evidence.required, status: t(`evidenceStatus.${item.evidence.status}`) })}</td>
            <td><span className={`claims-badge claims-priority-${item.priority}`}>{t(`priority.${item.priority}`)}</span></td>
          </tr>)}</tbody></table></div>
        <div className="claims-footer"><p role="status" className="note">{t('showing', { count: page.items.length })}</p>
          {updatedAt && <p className="mono note">{t('updated', { time: intl.formatTime(updatedAt, { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }) })}</p>}</div>
        {page.next && <div className="audit-pagination"><button className="btn btn-secondary" type="button" onClick={() => { moveFocus.current = true; setBefore(page.next ?? undefined); }}>{t('next')}</button></div>}
      </> : <div className="audit-state" role="status">
        <p>{filtered ? t('emptyFiltered', { filter: search ? search : t(`filter.${filter}`) }) : t('empty')}</p>
        {filtered && <><p className="note">{t('emptyHint')}</p><button type="button" className="btn btn-secondary" onClick={clear}>{t('clearFilter')}</button></>}
      </div>)}
    </div>
  </main>;
}
