import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { downloadDocument, listPolicies, readPolicyDetail, type PolicyDetail, type PolicyDocumentId, type PolicyFile, type PolicyOutcome, type PolicySummary } from './api';
import './policies.css';
import { AdvisorActions } from '../advisor/AdvisorActions';
import { LifecycleActions } from './LifecycleActions';

type Failure = Exclude<PolicyOutcome<never>, { kind: 'ok' }>['kind'];
type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: Failure };
type Tab = 'info' | 'documents' | 'history';
const TABS: readonly Tab[] = ['info', 'documents', 'history'];

function useTranslate() {
  const intl = useIntl();
  return (key: string, values?: Record<string, string | number>) => intl.formatMessage({ id: `policies.${key}`, defaultMessage: key }, values);
}

function useLoad<T>(load: (signal: AbortSignal) => Promise<PolicyOutcome<T>>, onSessionLost: () => void) {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).then(outcome => {
      if (abort.signal.aborted) return;
      if (outcome.kind === 'unauthenticated') onSessionLost();
      setState(outcome.kind === 'ok' ? { kind: 'ready', value: outcome.value } : { kind: outcome.kind });
    }).catch(() => { if (!abort.signal.aborted) setState({ kind: 'unavailable' }); });
    return () => abort.abort();
  }, [load, attempt, onSessionLost]);
  return { state, retry: () => { setState({ kind: 'loading' }); setAttempt(value => value + 1); } };
}

function policyState(policy: PolicySummary, now: number): 'active' | 'upcoming' | 'expired' | 'cancelled' | 'modified' | 'renewed' {
  if (policy.contractStatus) return policy.contractStatus;
  if ('lifecycle' in policy && policy.lifecycle) return (policy as PolicyDetail).lifecycle?.action ?? 'active';
  if (now < Date.parse(policy.effectiveFrom)) return 'upcoming';
  return now < Date.parse(policy.effectiveUntil) ? 'active' : 'expired';
}
const stateClass = { active: 'pill-ok', upcoming: 'pill-pending', expired: 'pill-status-expired', cancelled: 'pill-status-expired', modified: 'pill-pending', renewed: 'pill-pending' } as const;

function Failed({ kind, onRetry }: { kind: Failure; onRetry: () => void }) {
  const t = useTranslate();
  return <div className="banner banner-error" role="alert"><p>{t(kind === 'unavailable' ? 'unavailable' : kind)}</p>
    {kind === 'unavailable' && <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>{t('retry')}</button>}</div>;
}

function useHeading() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return heading;
}

function Validity({ policy }: { policy: PolicySummary }) {
  const t = useTranslate();
  const format = useFormatters();
  return <>{t('validity', { from: format.dayMonthYear(new Date(policy.effectiveFrom)), until: format.dayMonthYear(new Date(policy.effectiveUntil)) })}</>;
}

function PolicyList({ onOpen, onSessionLost }: { onOpen(policyId: string): void; onSessionLost(): void }) {
  const t = useTranslate();
  const format = useFormatters();
  const heading = useHeading();
  const { state, retry } = useLoad(listPolicies, onSessionLost);
  const [now] = useState(Date.now);
  return <main className="content policies">
    <p className="section-label">{t('label')}</p>
    <h1 ref={heading} tabIndex={-1}>{t('title')}</h1>
    <p className="lede">{t('subtitle')}</p>
    {state.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {state.kind !== 'loading' && state.kind !== 'ready' && <Failed kind={state.kind} onRetry={retry} />}
    {state.kind === 'ready' && (state.value.policies.length ? <ul className="policy-list">{state.value.policies.map(policy => {
      const status = policyState(policy, now), product = t(`product.${policy.product}`);
      return <li key={policy.policyId}><button type="button" className="card policy-card" aria-label={t('open.detail', { product }) + ' · ' + policy.policyId.slice(0, 8)} onClick={() => onOpen(policy.policyId)}>
        <span className="policy-card-head"><span className="h-card">{product}</span><span className={`pill ${stateClass[status]}`}>{t(`state.${status}`)}</span></span>
        <span className="mono policy-id">{policy.policyId}</span>
        <span className="policy-card-meta"><span><Validity policy={policy} /></span><span className="mono">{format.copDecimalAmount(policy.premium)}</span></span>
      </button></li>;
    })}</ul> : <div className="card policy-empty"><p>{t('empty')}</p><a className="btn btn-primary" href="/cotizar">{t('quote')}</a></div>)}
    {state.kind === 'ready' && state.value.hasMore && <p className="note" role="status">{t('truncated')}</p>}
  </main>;
}

function Coverage({ policy }: { policy: PolicyDetail }) {
  const t = useTranslate();
  const format = useFormatters();
  const rows: [string, React.ReactNode][] = [['coverage.type', t(`product.${policy.product}`)]];
  if (policy.coverage.kind === 'mortgage_life') rows.push(['coverage.sumInsured', format.copDecimalAmount(policy.coverage.sumInsured)]);
  else if (policy.coverage.kind === 'flight_delay') rows.push(['coverage.payout', format.copDecimalAmount(policy.coverage.payoutAmount)], ['coverage.threshold', t('coverage.thresholdValue', { minutes: policy.coverage.thresholdMinutes })],
    ['coverage.flight', <span className="mono" key="flight">{policy.coverage.flightReference}</span>]);
  else rows.push(['coverage.rainPayout', format.copDecimalAmount(policy.coverage.payoutAmount)], ['coverage.rainThreshold', t('coverage.rainValue', { mm: policy.coverage.threshold })],
    ['coverage.station', <span className="mono" key="station">{policy.coverage.stationId}</span>]);
  rows.push(['coverage.validity', <Validity policy={policy} key="validity" />], ['coverage.premium', format.copDecimalAmount(policy.premium)]);
  return <>
    <section className="card policy-section" aria-labelledby="policy-coverage"><h2 id="policy-coverage" className="h-card">{t('coverage')}</h2>
      <dl className="policy-facts">{rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl></section>
    <section className="card policy-section" aria-labelledby="policy-exclusions"><h2 id="policy-exclusions" className="h-card">{t('exclusions')}</h2>
      <ul className="policy-exclusions">{policy.exclusions.map(item => <li key={item.code}><span className="mono">{item.code}</span><span>{item.text}</span></li>)}</ul>
      <p className="note">{t('exclusionsNote', { version: policy.conditionsVersion })}</p></section>
  </>;
}

function savePdf(file: PolicyFile) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Documents({ policy, onSessionLost }: { policy: PolicyDetail; onSessionLost(): void }) {
  const t = useTranslate();
  const format = useFormatters();
  const [busy, setBusy] = useState<PolicyDocumentId | null>(null);
  const [failed, setFailed] = useState(false);
  async function download(documentId: PolicyDocumentId) {
    setBusy(documentId);
    setFailed(false);
    const outcome = await downloadDocument(policy.policyId, documentId);
    setBusy(null);
    if (outcome.kind === 'ok') savePdf(outcome.value);
    else if (outcome.kind === 'unauthenticated') onSessionLost();
    else setFailed(true);
  }
  return <section className="card policy-section" aria-labelledby="policy-documents"><h2 id="policy-documents" className="h-card">{t('documents')}</h2>
    {failed && <div className="banner banner-error" role="alert"><p>{t('downloadFailed')}</p></div>}
    <ul className="policy-documents">{policy.documents.map(item => <li key={item.documentId}>
      <span><strong>{t(`document.${item.documentId}`)}</strong><span className="note">{t('documentIssued', { date: format.dateTime(new Date(item.issuedAt)) })}</span></span>
      <button type="button" className="btn btn-secondary btn-small" disabled={busy !== null} aria-label={t('downloadLabel', { document: t(`document.${item.documentId}`) })}
        onClick={() => void download(item.documentId)}>{busy === item.documentId ? t('downloading') : t('download')}</button>
    </li>)}</ul></section>;
}

function History({ policy }: { policy: PolicyDetail }) {
  const t = useTranslate();
  const format = useFormatters();
  return <section className="card policy-section" aria-labelledby="policy-history"><h2 id="policy-history" className="h-card">{t('history')}</h2>
    <div className="policy-table-wrap"><table className="policy-table"><caption className="visually-hidden">{t('history')}</caption>
      <thead><tr>{['date', 'amount', 'status', 'reference'].map(key => <th key={key} scope="col">{t(`col.${key}`)}</th>)}</tr></thead>
      <tbody>{policy.payments.map(payment => <tr key={payment.date + payment.amount}>
        <td data-label={t('col.date')}>{format.dateTime(new Date(payment.date))}</td><td data-label={t('col.amount')} className="mono">{format.copDecimalAmount(payment.amount)}</td>
        <td data-label={t('col.status')}><span className={`pill policy-payment-${payment.status}`}>{t(`payment.${payment.status}`)}</span></td>
        <td data-label={t('col.reference')} className="mono">{payment.reference ?? t('noReference')}</td></tr>)}</tbody></table></div>
    <p className="note">{t('synthetic')}</p></section>;
}

function Tabs({ tab, onChange }: { tab: Tab; onChange(tab: Tab): void }) {
  const t = useTranslate();
  const buttons = useRef<Record<Tab, HTMLButtonElement | null>>({ info: null, documents: null, history: null });
  function move(event: KeyboardEvent, from: Tab) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(from) + step + TABS.length) % TABS.length];
    onChange(next);
    buttons.current[next]?.focus();
  }
  return <div className="policy-tabs" role="tablist" aria-label={t('tabs')}>{TABS.map(name => <button key={name} type="button" role="tab" id={`policy-tab-${name}`}
    ref={element => { buttons.current[name] = element; }} aria-selected={tab === name} aria-controls={`policy-panel-${name}`} tabIndex={tab === name ? 0 : -1}
    onClick={() => onChange(name)} onKeyDown={event => move(event, name)}>{t(`tab.${name}`)}</button>)}</div>;
}

function PolicyDetailView({ policyId, onBack, onSessionLost }: { policyId: string; onBack(): void; onSessionLost(): void }) {
  const t = useTranslate();
  const heading = useHeading();
  const [tab, setTab] = useState<Tab>('info');
  const load = useCallback((signal: AbortSignal) => readPolicyDetail(policyId, signal), [policyId]);
  const { state, retry } = useLoad(load, onSessionLost);
  const [now] = useState(Date.now);
  const policy = state.kind === 'ready' ? state.value : null;
  const status = policy ? policyState(policy, now) : null;
  return <main className="content policies">
    <button type="button" className="btn btn-secondary btn-small policy-back" onClick={onBack}>‹ {t('back')}</button>
    <p className="section-label">{t('label')}</p>
    <h1 ref={heading} tabIndex={-1}>{policy ? t(`product.${policy.product}`) : t('title')}</h1>
    {state.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {state.kind !== 'loading' && state.kind !== 'ready' && <Failed kind={state.kind} onRetry={retry} />}
    {policy && status && <>
      <p className="policy-summary"><span className={`pill ${stateClass[status]}`}>{t(`state.${status}`)}</span><span className="mono policy-id">{policy.policyId}</span></p>
      <Tabs tab={tab} onChange={setTab} />
      <div role="tabpanel" id={`policy-panel-${tab}`} aria-labelledby={`policy-tab-${tab}`}>
        {tab === 'info' && <Coverage policy={policy} />}
        {tab === 'documents' && <Documents policy={policy} onSessionLost={onSessionLost} />}
        {tab === 'history' && <History policy={policy} />}
      </div>
      <LifecycleActions policy={policy} onChanged={retry} onSessionLost={onSessionLost} />
      <AdvisorActions key={policy.policyId} policy={policy} onSessionLost={onSessionLost} />
    </>}
  </main>;
}

export function PolicyPortal({ onSessionLost }: { onSessionLost(): void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return selected ? <PolicyDetailView policyId={selected} onBack={() => setSelected(null)} onSessionLost={onSessionLost} />
    : <PolicyList onOpen={setSelected} onSessionLost={onSessionLost} />;
}
