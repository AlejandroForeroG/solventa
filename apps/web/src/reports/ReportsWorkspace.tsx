import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { DESTINATIONS, downloadReport, generateReport, listReports, sendReport, type Destination, type Report, type ReportsOutcome, type ReportsPage } from './api';
import { AccessDenied } from '../navigation/AccessDenied';
import '../audit/audit.css';
import '../claims/claims.css';
import './reports.css';
import { Icon } from '../navigation/Icon';
import { keepMeridiem } from '../i18n/I18n';

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
  const month = (value: string) => intl.formatDate(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, 1), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const [filter, setFilter] = useState<Filter>('all');
  const [before, setBefore] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ view: string; state: State } | null>(null);
  const [period, setPeriod] = useState(periods[0]);
  const [destination, setDestination] = useState<Destination>('regulator');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => { if (confirming) document.getElementById(`report-confirm-${confirming}`)?.focus(); }, [confirming]);
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
  // A report opened in a background tab loads when the window comes back, as the claims inbox does.
  useEffect(() => {
    const reload = () => setRefresh(value => value + 1);
    document.addEventListener('visibilitychange', reload);
    window.addEventListener('focus', reload);
    return () => { document.removeEventListener('visibilitychange', reload); window.removeEventListener('focus', reload); };
  }, []);
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
    <div className="audit-main">
      <div className="audit-heading"><span className="page-icon page-icon-amber" aria-hidden="true"><Icon name="reports" size={22} /></span><div className="audit-heading-text"><p className="section-label">{t('console')}</p><h1 ref={heading} tabIndex={-1}>{t('title')}</h1><p className="note audit-mode">{t('subtitle')}</p></div></div>
      {state.kind === 'forbidden' ? <AccessDenied message={t('forbidden')} traceId={'traceId' in state ? state.traceId : undefined} /> : <>
      <form className="card reports-form" aria-labelledby="reports-form-title" onSubmit={event => { event.preventDefault(); void generate(); }}>
        <h2 id="reports-form-title" className="reports-form-title"><Icon name="file" size={18} />{t('form')}</h2>
        <label>{t('period')}<select value={period} onChange={event => setPeriod(event.target.value)}>{periods.map(option => <option key={option} value={option}>{month(option)}</option>)}</select></label>
        <label>{t('destination')}<select value={destination} onChange={event => setDestination(event.target.value as Destination)}>
          {DESTINATIONS.map(option => <option key={option} value={option}>{t(`destination.${option}`)}</option>)}</select></label>
        <p className="reports-format"><span>{t('format')}</span>{t('formatValue')}</p>
        <button className="btn btn-primary" type="submit" disabled={busy !== null}><Icon name="file" size={18} />{busy === 'generate' ? t('generating') : t('generate')}</button>
      </form>
      {notice && notice.text && <p className={notice.kind === 'alert' ? 'claims-error' : 'note'} role={notice.kind}>{notice.text}</p>}
      <p className="section-label reports-filter-label" id="reports-filter-label">{t('filterGroup')}</p>
      <div role="group" aria-labelledby="reports-filter-label" className="claims-filters reports-filters">
        {(['all', ...DESTINATIONS] as const).map(option => <button key={option} type="button" className="claims-filter" aria-pressed={filter === option}
          onClick={() => { moveFocus.current = true; setFilter(option); setBefore(undefined); }}>{t(`destination.${option}`)}</button>)}
      </div>
      {state.kind !== 'ready' && <div className="audit-state" role={state.kind === 'loading' || state.kind === 'hidden' ? 'status' : 'alert'}>
        <p>{t(state.kind)}</p>{state.kind !== 'loading' && state.kind !== 'hidden' && state.kind !== 'unauthenticated'
          && <button type="button" className="btn btn-secondary" onClick={() => { moveFocus.current = true; setResult(null); setRefresh(value => value + 1); }}>{t('retryLoad')}</button>}
        {'traceId' in state && state.traceId && <p className="mono audit-id">{state.traceId}</p>}
      </div>}
      {page && (page.items.length ? <>
        <div className="audit-table-wrap audit-card-wrap"><table className="audit-table audit-card-table reports-table"><caption className="visually-hidden">{t('title')}</caption>
          <thead><tr>{['period', 'revision', 'generated', 'hash', 'rows', 'delivery', 'actions'].map(key => <th key={key} scope="col">{t(`col.${key}`)}</th>)}</tr></thead>
          <tbody>{page.items.map(report => { const label = `reports-row-${report.reportId}`; const status = report.delivery?.status; return <tr key={report.reportId}>
            <td data-label={t('col.period')}><span id={label}>{month(report.period)} · {t(`destination.${report.destination}`)}</span></td>
            <td className="mono" data-label={t('col.revision')}>{t('revision', { revision: report.revision })}</td>
            <td className="mono" data-label={t('col.generated')}>{keepMeridiem(intl.formatDate(report.generatedAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }))}</td>
            <td className="mono audit-id" data-label={t('col.hash')} title={report.contentHash}>{report.contentHash.slice(0, 12)}</td>
            <td className="mono" data-label={t('col.rows')}>{t('rows', { count: report.manifest.rowCount })}</td>
            <td data-label={t('col.delivery')}><span className={`claims-badge reports-delivery-${status ?? 'none'}`}>{t(`delivery.${status ?? 'none'}`)}</span>
              {report.delivery?.rejectionCode && <span className="note reports-reason">{t('rejection', { code: report.delivery.rejectionCode })}</span>}</td>
            <td className="reports-actions" data-label={t('col.actions')}><div>
              <button type="button" className="btn btn-secondary btn-small" aria-describedby={label} disabled={busy !== null} onClick={() => void download(report, 'csv')}><Icon name="download" size={16} />{t('downloadCsv')}</button>
              <button type="button" className="btn btn-secondary btn-small" aria-describedby={label} disabled={busy !== null} onClick={() => void download(report, 'manifest')}><Icon name="download" size={16} />{t('downloadManifest')}</button>
              {!isFinal(report) && confirming !== report.reportId && <button type="button" id={`report-send-${report.reportId}`} className="btn btn-primary btn-small" aria-describedby={label} disabled={busy !== null}
                onClick={() => { if (status && status !== 'pending') void send(report); else setConfirming(report.reportId); }}>
                <Icon name={status && status !== 'pending' ? 'refresh' : 'send'} size={16} />{busy === report.reportId ? t('sending') : status && status !== 'pending' ? t('retry') : t(`send.${report.destination}`)}</button>}
            </div>
            {confirming === report.reportId && <div className="reports-confirm" role="group" aria-label={t('confirmTitle')}>
              <p className="note">{t('confirmSend', { month: month(report.period), revision: report.revision, rows: report.manifest.rowCount, destination: t(`destination.${report.destination}`) })}</p>
              <div><button type="button" id={`report-confirm-${report.reportId}`} className="btn btn-primary btn-small" disabled={busy !== null} onClick={() => { setConfirming(null); void send(report); }}><Icon name="send" size={16} />{t('confirmButton')}</button>
                <button type="button" className="btn btn-secondary btn-small" disabled={busy !== null} onClick={() => { const id = confirming; setConfirming(null); requestAnimationFrame(() => document.getElementById(`report-send-${id}`)?.focus()); }}>{t('cancelSend')}</button></div>
            </div>}</td>
          </tr>; })}</tbody></table></div>
        {page.next && <div className="audit-pagination"><button className="btn btn-secondary" type="button" onClick={() => { moveFocus.current = true; setBefore(page.next ?? undefined); }}>{t('next')}</button></div>}
      </> : <div className="audit-state" role="status"><p>{filter === 'all' ? t('empty') : t('emptyFiltered')}</p></div>)}
      </>}
    </div>
  </main>;
}
