import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import { downloadDocument, listPolicies, readPolicyDetail, readPolicyFingerprint, type PolicyDetail, type PolicyDocumentId, type PolicyOutcome, type PolicySummary } from './api';
import './policies.css';
import { AdvisorActions } from '../advisor/AdvisorActions';
import { LifecycleActions } from './LifecycleActions';
import type { PolicyDocumentDestination } from './document-destination';
import { customerDestination, type PolicyDestination } from '../navigation/customer-destination';
import { Icon, type IconName } from '../navigation/Icon';
import { DocClauses, DocSection, DocSignature, DocTable, DocVerification, DocumentSheet, type SheetStatus } from '../offer/DocumentSheet';
import { policyNumber, savePdf, signatureStroke, usePrintSheet } from '../offer/document-tools';

type Failure = Exclude<PolicyOutcome<never>, { kind: 'ok' }>['kind'];
type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: Failure };
type Tab = 'info' | 'documents' | 'history' | 'manage';
const TABS: readonly Tab[] = ['info', 'documents', 'history', 'manage'];

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
const stateClass = { active: 'pill-ok', upcoming: 'pill-pending', expired: 'pill-status-expired', cancelled: 'pill-status-revoked', modified: 'pill-pending', renewed: 'pill-pending' } as const;
const productIcon: Record<PolicySummary['product'], IconName> = { vida_hipotecario: 'policy', flight_delay: 'plane', weather_event: 'rain' };
const sheetStatus = { active: 'signed', upcoming: 'signed', modified: 'signed', renewed: 'signed', expired: 'expired', cancelled: 'cancelled' } as const satisfies Record<ReturnType<typeof policyState>, SheetStatus>;
const fileKey: Record<PolicyDocumentId, string> = { signed_policy: 'sheet.fileSignedPolicy', general_conditions: 'sheet.fileGeneralConditions', premium_receipt: 'sheet.filePremiumReceipt' };

function Failed({ kind, onRetry }: { kind: Failure; onRetry: () => void }) {
  const t = useTranslate();
  return <div className="banner banner-error" role="alert"><Icon name="alert" size={18} className="banner-icon" /><p>{t(kind === 'unavailable' ? 'unavailable' : kind)}</p>
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

function PolicyList({ onOpen, onSessionLost, cursors, onPage }: { onOpen(policyId: string): void; onSessionLost(): void;
  cursors: (string | undefined)[]; onPage(cursors: (string | undefined)[]): void }) {
  const t = useTranslate();
  const format = useFormatters();
  const heading = useHeading();
  const cursor = cursors.at(-1);
  const readPage = useCallback((signal: AbortSignal) => listPolicies(signal, { cursor }), [cursor]);
  const { state, retry } = useLoad(readPage, onSessionLost);
  const changePage = (next: (string | undefined)[]) => { retry(); onPage(next); heading.current?.focus(); };
  const [now] = useState(Date.now);
  return <main className="content policies">
    <p className="section-label">{t('label')}</p>
    <div className="page-title"><span className="page-icon page-icon-green" aria-hidden="true"><Icon name="policy" size={22} /></span><h1 ref={heading} tabIndex={-1}>{t('title')}</h1></div>
    {state.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {state.kind !== 'loading' && state.kind !== 'ready' && <Failed kind={state.kind} onRetry={retry} />}
    {state.kind === 'ready' && (state.value.policies.length ? <ul className="policy-list">{state.value.policies.map(policy => {
      const status = policyState(policy, now), product = t(`product.${policy.product}`);
      return <li key={policy.policyId}><button type="button" className="card policy-card" aria-label={`${t('open.detail', { product })} · POL-${policy.policyId.slice(0, 8).toUpperCase()} · ${t(`state.${status}`)}`} onClick={() => onOpen(policy.policyId)}>
        <span className="policy-card-head"><span className={`policy-card-icon policy-card-icon-${policy.product}`} aria-hidden="true"><Icon name={productIcon[policy.product]} size={22} /></span>
          <span className="policy-card-title"><span className="h-card">{product}</span><span className="mono policy-id">{policyNumber(policy.policyId)}</span></span>
          <span className={`pill ${stateClass[status]}`}>{t(`state.${status}`)}</span></span>
        <span className="policy-card-meta"><span className="policy-card-fact"><Icon name="calendar" size={16} /><Validity policy={policy} /></span><span className="policy-card-fact mono"><Icon name="coins" size={16} />{format.copDecimalAmount(policy.premium)} <span className="note">{t('oneOff')}</span></span></span>
        <Icon name="arrow" size={18} className="policy-card-arrow" />
      </button></li>;
    })}</ul> : <div className="card empty-state policy-empty"><span className="empty-state-art" aria-hidden="true"><Icon name="policy" size={30} /></span><h2>{t(cursors.length > 1 ? 'emptyPage' : 'empty')}</h2>
      {cursors.length === 1 && <><p className="note">{t('emptyHint')}</p><a className="btn btn-primary" href="/cotizar"><Icon name="quote" size={18} />{t('quote')}</a></>}</div>)}
    {(cursors.length > 1 || state.kind === 'ready' && state.value.hasMore) && <nav className="actions" aria-label={t('pagination')}>
      <button type="button" className="btn btn-secondary" disabled={state.kind === 'loading' || cursors.length === 1}
        onClick={() => changePage(cursors.slice(0, -1))}><Icon name="back" size={16} />{t('previousPage')}</button>
      <span className="note" role="status">{t('page', { number: cursors.length })}</span>
      <button type="button" className="btn btn-secondary" disabled={state.kind !== 'ready' || !state.value.nextCursor}
        onClick={() => { if (state.kind === 'ready' && state.value.nextCursor) changePage([...cursors, state.value.nextCursor]); }}>{t('nextPage')}<Icon name="next" size={16} /></button>
    </nav>}
  </main>;
}

function useFingerprint(policyId: string) {
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void readPolicyFingerprint(policyId, abort.signal).then(value => { if (!abort.signal.aborted) setHash(value); });
    return () => abort.abort();
  }, [policyId]);
  return hash;
}

function PolicySheet({ policy, status, hash }: { policy: PolicyDetail; status: ReturnType<typeof policyState>; hash: string | null }) {
  const intl = useIntl();
  const t = useTranslate();
  const format = useFormatters();
  const sheet = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [{ label: t('coverage.type'), value: policy.product === 'vida_hipotecario' ? sheet('offer.coverageValue') : t(`product.${policy.product}`) }];
  if (policy.coverage.kind === 'mortgage_life') rows.push({ label: t('coverage.sumInsured'), value: <span className="doc-amount">{format.copDecimalAmount(policy.coverage.sumInsured)}</span> });
  else if (policy.coverage.kind === 'flight_delay') rows.push({ label: t('coverage.payout'), value: <span className="doc-amount">{format.copDecimalAmount(policy.coverage.payoutAmount)}</span> },
    { label: t('coverage.threshold'), value: t('coverage.thresholdValue', { minutes: policy.coverage.thresholdMinutes }) },
    { label: t('coverage.flight'), value: policy.coverage.flightReference, mono: true });
  else rows.push({ label: t('coverage.rainPayout'), value: <span className="doc-amount">{format.copDecimalAmount(policy.coverage.payoutAmount)}</span> },
    { label: t('coverage.rainThreshold'), value: t('coverage.rainValue', { mm: policy.coverage.threshold }) },
    { label: t('coverage.station'), value: policy.coverage.stationId, mono: true });
  rows.push({ label: t('coverage.validity'), value: sheet('offer.periodValue', { from: format.longDate(new Date(policy.effectiveFrom)), until: format.longDate(new Date(policy.effectiveUntil)) }) },
    { label: t('coverage.premium'), value: <span className="doc-amount">{format.copDecimalAmount(policy.premium)}</span> });
  const signed = policy.documents.find(item => item.documentId === 'signed_policy');
  const signedAt = signed ? sheet('sheet.bogotaTime', { time: format.longDateTime(new Date(signed.issuedAt)) }) : null;
  const payment = policy.payments[0];
  const mortgage = policy.product === 'vida_hipotecario';
  return <DocumentSheet kicker={sheet('sheet.kicker')} title={mortgage ? sheet('sheet.policyTitle') : sheet('sheet.parametricTitle', { product: t(`product.${policy.product}`) })}
    number={policyNumber(policy.policyId)} meta={signedAt ? <span>{sheet('sheet.issuedOn', { date: signedAt })}</span> : undefined}
    status={sheetStatus[status]} statusLabel={t(`state.${status}`)} page={1} total={1}>
    <DocSection number={1} title={sheet('sheet.sectionGeneral')}>
      <DocTable rows={[
        { label: sheet('sheet.product'), value: t(`product.${policy.product}`) },
        { label: t('reference'), value: policyNumber(policy.policyId), mono: true },
        { label: sheet('sheet.holder'), value: sheet('sheet.holderAccount') },
        { label: sheet('sheet.status'), value: t(`state.${status}`) },
      ]} />
    </DocSection>
    <DocSection number={2} title={t('coverage')} id="policy-coverage"><DocTable rows={rows} /></DocSection>
    <DocSection number={3} title={sheet('sheet.sectionPremium')}>
      <DocTable rows={[
        { label: sheet('sheet.paymentTerms'), value: sheet('sheet.coverageNote') },
        ...(payment ? [{ label: sheet('sheet.paymentState'), value: t(`payment.${payment.status}`) },
          { label: sheet('charge.receipt'), value: payment.reference ?? t('noReference'), mono: !!payment.reference }] : []),
      ]} />
    </DocSection>
    <DocSection number={4} title={t('exclusions')} id="policy-exclusions">
      <p className="doc-section-intro">{sheet('sheet.exclusionsIntro')} {t('exclusionsNote', { version: policy.conditionsVersion })}</p>
      <DocClauses items={policy.exclusions} />
      {intl.locale === 'en-US' && <p className="doc-section-intro">{t('contractLanguage')}</p>}
    </DocSection>
    <DocSection number={5} title={sheet('sheet.sectionSignature')}>
      <DocSignature signed name={sheet('sheet.holderAccount')} role={sheet('sheet.holderRole')} signedAt={signedAt} method={sheet('sheet.signatureMethodValue')}
        reference={hash ? `SHA-256 ${hash.slice(0, 16)}…` : undefined} stroke={signatureStroke(hash ?? policy.policyId.replace(/-/g, ''))} />
    </DocSection>
    <DocSection number={6} title={sheet('sheet.sectionVerification')}>
      <DocVerification hash={hash} rows={[
        { label: t('reference'), value: policyNumber(policy.policyId), mono: true },
        { label: sheet('sheet.conditionsVersion'), value: policy.conditionsVersion, mono: true },
      ]} />
    </DocSection>
  </DocumentSheet>;
}

function Coverage({ policy, status, onSessionLost }: { policy: PolicyDetail; status: ReturnType<typeof policyState>; onSessionLost(): void }) {
  const intl = useIntl();
  const hash = useFingerprint(policy.policyId);
  const { print, portal } = usePrintSheet();
  const [download, setDownload] = useState<'idle' | 'busy' | 'failed'>('idle');
  const sheet = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const number = policyNumber(policy.policyId);
  async function save() {
    setDownload('busy');
    const outcome = await downloadDocument(policy.policyId, 'signed_policy');
    if (outcome.kind === 'ok') { savePdf(outcome.value.blob, `${sheet('sheet.fileSignedPolicy', { number })}.pdf`); setDownload('idle'); return; }
    if (outcome.kind === 'unauthenticated') onSessionLost();
    setDownload('failed');
  }
  return <div className="card doc-viewer">
    <div className="doc-toolbar">
      <p className="doc-toolbar-name"><Icon name="file" size={18} />{sheet('sheet.viewerName')}</p>
      <div className="doc-toolbar-tools">
        <button type="button" className="btn btn-primary btn-small" aria-disabled={download === 'busy'} onClick={download === 'busy' ? undefined : () => void save()}>
          <Icon name="download" size={16} />{sheet(download === 'busy' ? 'sheet.pdfBusy' : 'sheet.pdf')}</button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => print(sheet('sheet.fileSignedPolicy', { number }), <PolicySheet policy={policy} status={status} hash={hash} />)}>
          <Icon name="printer" size={16} />{sheet('sheet.printSheet')}</button>
      </div>
    </div>
    {download === 'failed' && <p className="banner banner-error doc-download-error" role="alert"><Icon name="alert" size={18} className="banner-icon" /><span>{sheet('sheet.downloadFailed')}</span></p>}
    <div className="doc-desk"><PolicySheet policy={policy} status={status} hash={hash} /></div>
    {portal}
  </div>;
}

function Documents({ policy, onSessionLost }: { policy: PolicyDetail; onSessionLost(): void }) {
  const intl = useIntl();
  const t = useTranslate();
  const format = useFormatters();
  const [busy, setBusy] = useState<PolicyDocumentId | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState('');
  const fileName = (documentId: PolicyDocumentId) => `${intl.formatMessage({ id: fileKey[documentId] }, { number: policyNumber(policy.policyId) })}.pdf`;
  async function download(documentId: PolicyDocumentId) {
    setBusy(documentId);
    setFailed(false);
    setSaved('');
    const outcome = await downloadDocument(policy.policyId, documentId);
    setBusy(null);
    if (outcome.kind === 'ok') { savePdf(outcome.value.blob, fileName(documentId)); setSaved(intl.formatMessage({ id: 'sheet.downloaded' }, { file: fileName(documentId) })); }
    else if (outcome.kind === 'unauthenticated') onSessionLost();
    else setFailed(true);
  }
  return <section className="card policy-section" aria-labelledby="policy-documents"><h2 id="policy-documents" className="h-card">{t('documents')}</h2>
    {failed && <div className="banner banner-error" role="alert"><Icon name="alert" size={18} className="banner-icon" /><p>{t('downloadFailed')}</p></div>}
    <ul className="policy-documents doc-files">{policy.documents.map(item => <li key={item.documentId}>
      <span className="doc-file-icon" aria-hidden="true"><Icon name="file" size={22} /><span>PDF</span></span>
      <span className="doc-file-copy"><strong>{t(`document.${item.documentId}`)}</strong><span className="note">{t('documentIssued', { date: format.dateTime(new Date(item.issuedAt)) })}</span>
        <span className="doc-file-name mono">{fileName(item.documentId)}</span></span>
      <button type="button" className="btn btn-secondary btn-small" disabled={busy !== null} aria-label={t('downloadLabel', { document: t(`document.${item.documentId}`) })}
        onClick={() => void download(item.documentId)}><Icon name="download" size={16} />{busy === item.documentId ? t('downloading') : t('download')}</button>
    </li>)}</ul>
    <p className="note doc-saved" role="status">{saved}</p></section>;
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
    {policy.parametricPayment && <section aria-labelledby="parametric-payment"><h3 id="parametric-payment">{t('parametricPayment')}</h3>
      <dl className="policy-facts">
        <div><dt>{t('col.date')}</dt><dd>{format.dateTime(new Date(policy.parametricPayment.date))}</dd></div>
        <div><dt>{t('col.amount')}</dt><dd className="mono">{format.copDecimalAmount(policy.parametricPayment.amount)}</dd></div>
        <div><dt>{t('col.status')}</dt><dd>{t(`payment.${policy.parametricPayment.status}`)}</dd></div>
        <div><dt>{t('col.reference')}</dt><dd className="mono">{policy.parametricPayment.reference ?? t('noReference')}</dd></div>
      </dl></section>}
    <p className="note">{t('synthetic')}</p></section>;
}

function Tabs({ tab, onChange }: { tab: Tab; onChange(tab: Tab): void }) {
  const t = useTranslate();
  const buttons = useRef<Record<Tab, HTMLButtonElement | null>>({ info: null, documents: null, history: null, manage: null });
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

function PolicyDetailView({ policyId, initialTab = 'info', renewal = false, onBack, onSessionLost }: { policyId: string; initialTab?: Tab; renewal?: boolean; onBack(): void; onSessionLost(): void }) {
  const t = useTranslate();
  const format = useFormatters();
  const heading = useHeading();
  const [tab, setTab] = useState<Tab>(initialTab);
  const load = useCallback((signal: AbortSignal) => readPolicyDetail(policyId, signal), [policyId]);
  const { state, retry } = useLoad(load, onSessionLost);
  const [now] = useState(Date.now);
  const policy = state.kind === 'ready' ? state.value : null;
  const status = policy ? policyState(policy, now) : null;
  return <main className="content policies">
    <button type="button" className="btn btn-secondary btn-small policy-back" onClick={onBack}><Icon name="back" size={16} />{t('back')}</button>
    <p className="section-label">{t('label')}</p>
    <h1 ref={heading} tabIndex={-1}>{policy ? t(`product.${policy.product}`) : t('title')}</h1>
    {state.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {state.kind !== 'loading' && state.kind !== 'ready' && <Failed kind={state.kind} onRetry={retry} />}
    {policy && status && <>
      <p className="policy-summary"><span className={`pill ${stateClass[status]}`}>{t(`state.${status}`)}</span><span className="mono policy-id">POL-{policy.policyId.slice(0, 8).toUpperCase()}</span></p>
      {policy.lifecycle && <div className={`banner ${policy.lifecycle.action === 'cancelled' ? 'banner-error' : 'banner-info'} policy-lifecycle-banner`} role="status">
        <Icon name={policy.lifecycle.action === 'cancelled' ? 'ban' : 'info'} size={18} className="banner-icon" />
        <p><strong>{t('lifecycleBanner', { state: t(`state.${policy.lifecycle.action}`), date: format.dateTime(new Date(policy.lifecycle.at)) + ' ' + t('hourBogota') })}</strong><br />
          {t('lifecycle.reason')}: {['customer_request', 'coverage_change', 'term_renewal'].includes(policy.lifecycle.reason) ? t(`lifecycle.${policy.lifecycle.reason}`) : policy.lifecycle.reason}. {t('lifecycle.recorded')}</p>
      </div>}
      <details className="document-verification"><summary>{t('fullReference')}</summary><p className="mono policy-id">{policy.policyId}</p></details>
      <Tabs tab={tab} onChange={setTab} />
      <div role="tabpanel" id={`policy-panel-${tab}`} aria-labelledby={`policy-tab-${tab}`}>
        {tab === 'info' && <Coverage policy={policy} status={status} onSessionLost={onSessionLost} />}
        {tab === 'documents' && <Documents policy={policy} onSessionLost={onSessionLost} />}
        {tab === 'history' && <History policy={policy} />}
        {tab === 'manage' && <AdvisorActions key={policy.policyId} policy={policy} openRenewal={renewal} onSessionLost={onSessionLost}>
          {!policy.lifecycle && <LifecycleActions policy={policy} initialAction={renewal ? 'renewed' : undefined} onChanged={retry} onSessionLost={onSessionLost} />}
        </AdvisorActions>}
      </div>
    </>}
  </main>;
}

export function PolicyPortal({ onSessionLost, documentDestination, destination: suppliedDestination, onBackToList }: {
  onSessionLost(): void; destination?: PolicyDestination; documentDestination?: PolicyDocumentDestination | null; onBackToList?(): void;
}) {
  const [destination, setDestination] = useState<PolicyDestination | null>(() => {
    const current = suppliedDestination ?? customerDestination();
    return documentDestination ? { kind: 'policy', policyId: documentDestination.policyId, section: 'documents' } : current?.kind === 'policy' ? current : null;
  });
  const [selected, setSelected] = useState<string | null>(destination?.policyId ?? null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const section = selected === destination?.policyId ? destination.section : 'info';
  return selected ? <PolicyDetailView policyId={selected} initialTab={section === 'renewal' ? 'manage' : section} renewal={section === 'renewal'} onBack={() => {
    window.history.replaceState(null, '', '/polizas'); setDestination(null); setSelected(null); onBackToList?.();
  }} onSessionLost={onSessionLost} />
    : <PolicyList onOpen={setSelected} onSessionLost={onSessionLost} cursors={cursors} onPage={setCursors} />;
}
