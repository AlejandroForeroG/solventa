import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { DESTINATIONS, downloadReport, generateReport, listReports, sendReport, type Destination, type Report, type ReportsOutcome, type ReportsPage } from './api';
import '../audit/audit.css';
import '../claims/claims.css';
import './reports.css';

type Filter = 'all' | Destination;
type State = { kind: 'loading' | 'hidden' } | { kind: 'ready'; page: ReportsPage } | Exclude<ReportsOutcome<never>, { kind: 'ok' }>;
type Notice = { kind: 'status' | 'alert'; text: string };
const BOGOTA_OFFSET_MS = 5 * 3_600_000;

// The last twelve Bogotá months, newest first; the server rejects a month that has not started.
function recentPeriods(now: Date): string[] {
  const local = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  return Array.from({ length: 12 }, (_, back) => {
    const month = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - back, 1));
    return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}
const isFinal = (report: Report) => report.delivery?.status === 'acknowledged' || report.delivery?.status === 'rejected';

export function ReportsWorkspace({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl();
  const t = (key: string, values?: Record<string, string | number>) => intl.formatMessage({ id: `reports.${key}`, defaultMessage: key }, values);
  const periods = useRef(recentPeriods(new Date())).current;
  const [filter, setFilter] = useState<Filter>('all');
  const [before, setBefore] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ view: string; state: State } | null>(null);
  const [period, setPeriod] = useState(periods[0]);
  const [destination, setDestination] = useState<Destination>('regulator');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(true);
  const view = [filter, before ?? ''].join('|');
  useEffect(() => {
    if (document.hidden) return;
    const abort = new AbortController();
    const query = new URLSearchParams();
    if (filter !== 'all') query.set('destination', filter);
    if (before) query.set('before', before);
    void listReports(query, abort.signal).then(outcome => {
      if (abort.signal.aborted) return;
      if (outcome.kind === 'unauthenticated') onSessionLost();
      setResult({ view, state: outcome.kind === 'ok' ? { kind: 'ready', page: outcome.value } : outcome });
      if (moveFocus.current) { moveFocus.current = false; heading.current?.focus(); }
    }).catch(() => { if (!abort.signal.aborted) setResult({ view, state: { kind: 'unavailable' } }); });
    return () => abort.abort();
  }, [view, filter, before, refresh, onSessionLost]);
  const state: State = result?.view === view ? result.state : { kind: document.hidden ? 'hidden' : 'loading' };
  const page = state.kind === 'ready' ? state.page : null;

  async function act<T>(name: string, work: () => Promise<ReportsOutcome<T>>, done: (value: T) => Notice) {
    setBusy(name); setNotice(null);
    const outcome = await work();
    setBusy(null);
    if (outcome.kind === 'ok') { setNotice(done(outcome.value)); setRefresh(value => value + 1); return; }
    if (outcome.kind === 'unauthenticated') onSessionLost();
    setNotice({ kind: 'alert', text: t(outcome.kind) });
  }
  const generate = () => act('generate', () => generateReport({ period, destination }),
    ({ report, created }) => ({ kind: 'status', text: t(created ? 'generatedNew' : 'generatedSame', { revision: report.revision }) }));
  const send = (report: Report) => act(report.reportId, () => sendReport(report.reportId), delivery => ({ kind: delivery.status === 'acknowledged' ? 'status' : 'alert',
    text: t(delivery.status === 'acknowledged' ? 'sentAcknowledged' : delivery.status === 'rejected' ? 'sentRejected' : 'sentUncertain') }));
  const download = (report: Report, file: 'csv' | 'manifest') => act(`${report.reportId}:${file}`, async () => {
    const outcome = await downloadReport(report.reportId, file);
    if (outcome.kind === 'ok') {
      const url = URL.createObjectURL(outcome.value.blob);
      const link = document.createElement('a');
      link.href = url; link.download = outcome.value.filename; link.click();
      URL.revokeObjectURL(url);
    }
    return outcome;
  }, () => ({ kind: 'status', text: '' }));

  return <main className="audit-shell">
    <aside className="audit-nav" aria-label={t('console')}><p>{t('console')}</p>
      <a href="/reportes" aria-current="page">{t('nav')}</a>
      <a href="/siniestros">{intl.formatMessage({ id: 'claims.open' })}</a>
      <a href="/auditoria">{intl.formatMessage({ id: 'audit.open' })}</a>
    </aside>
    <div className="audit-main">
      <div className="audit-heading"><div><p className="section-label">{t('console')}</p><h1 ref={heading} tabIndex={-1}>{t('title')}</h1><p className="note audit-mode">{t('subtitle')}</p></div></div>
      <form className="reports-form" aria-label={t('form')} onSubmit={event => { event.preventDefault(); void generate(); }}>
        <label>{t('period')}<select value={period} onChange={event => setPeriod(event.target.value)}>{periods.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
        <label>{t('destination')}<select value={destination} onChange={event => setDestination(event.target.value as Destination)}>
          {DESTINATIONS.map(option => <option key={option} value={option}>{t(`destination.${option}`)}</option>)}</select></label>
        <p className="reports-format"><span>{t('format')}</span>{t('formatValue')}</p>
        <button className="btn btn-primary" type="submit" disabled={busy !== null}>{busy === 'generate' ? t('generating') : t('generate')}</button>
      </form>
      {notice && notice.text && <p className={notice.kind === 'alert' ? 'claims-error' : 'note'} role={notice.kind}>{notice.text}</p>}
      <div role="group" aria-label={t('filterGroup')} className="claims-filters reports-filters">
        {(['all', ...DESTINATIONS] as const).map(option => <button key={option} type="button" className="claims-filter" aria-pressed={filter === option}
          onClick={() => { moveFocus.current = true; setFilter(option); setBefore(undefined); }}>{t(`destination.${option}`)}</button>)}
      </div>
      {state.kind !== 'ready' && <div className={`audit-state ${state.kind === 'forbidden' ? 'audit-denied' : ''}`} role={state.kind === 'loading' || state.kind === 'hidden' ? 'status' : 'alert'}>
        <p>{t(state.kind)}</p>{state.kind !== 'loading' && state.kind !== 'hidden' && state.kind !== 'unauthenticated' && state.kind !== 'forbidden'
          && <button type="button" className="btn btn-secondary" onClick={() => { moveFocus.current = true; setResult(null); setRefresh(value => value + 1); }}>{t('retryLoad')}</button>}
        {'traceId' in state && state.traceId && <p className="mono audit-id">{state.traceId}</p>}
      </div>}
      {page && (page.items.length ? <>
        <div className="audit-table-wrap"><table className="audit-table reports-table"><caption className="visually-hidden">{t('title')}</caption>
          <thead><tr>{['period', 'destination', 'revision', 'generated', 'hash', 'rows', 'delivery', 'actions'].map(key => <th key={key} scope="col">{t(`col.${key}`)}</th>)}</tr></thead>
          <tbody>{page.items.map(report => <tr key={report.reportId}>
            <td className="mono">{report.period}</td>
            <td>{t(`destination.${report.destination}`)}</td>
            <td className="mono">{t('revision', { revision: report.revision })}</td>
            <td className="mono">{intl.formatDate(report.generatedAt, { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' })}</td>
            <td className="mono audit-id" title={report.contentHash}>{report.contentHash.slice(0, 12)}</td>
            <td className="mono">{t('rows', { count: report.manifest.rowCount })}</td>
            <td><span className={`claims-badge reports-delivery-${report.delivery?.status ?? 'none'}`}>{t(`delivery.${report.delivery?.status ?? 'none'}`)}</span>
              {report.delivery?.rejectionCode && <span className="note reports-reason">{t('rejection', { code: report.delivery.rejectionCode })}</span>}</td>
            <td className="reports-actions">
              <button type="button" className="btn btn-secondary btn-small" disabled={busy !== null} onClick={() => void download(report, 'csv')}>{t('downloadCsv')}</button>
              <button type="button" className="btn btn-secondary btn-small" disabled={busy !== null} onClick={() => void download(report, 'manifest')}>{t('downloadManifest')}</button>
              <button type="button" className="btn btn-primary btn-small" disabled={busy !== null || isFinal(report)} onClick={() => void send(report)}>
                {busy === report.reportId ? t('sending') : report.delivery && report.delivery.status !== 'pending' ? t('retry') : t('send')}</button>
            </td>
          </tr>)}</tbody></table></div>
        {page.next && <div className="audit-pagination"><button className="btn btn-secondary" type="button" onClick={() => { moveFocus.current = true; setBefore(page.next ?? undefined); }}>{t('next')}</button></div>}
      </> : <div className="audit-state" role="status"><p>{filter === 'all' ? t('empty') : t('emptyFiltered')}</p></div>)}
    </div>
  </main>;
}
