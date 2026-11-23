import { useEffect, useRef, useState, type RefObject } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import type { Offer, Policy, SignatureChallenge } from './api';
import { Icon } from '../navigation/Icon';
import { downloadDocument, readPolicyDetail } from '../policies/api';
import { policyNumber, savePdf, usePrintSheet } from './document-tools';
import { DraftPolicyPage, IssuedPolicyPage, ReceiptPage } from './PolicySheets';

export function OfferCard({ heading, offer, accepting, onAccept, onReevaluate, onBack, assisted = false }: { heading: RefObject<HTMLHeadingElement | null>; offer: Offer; assisted?: boolean; accepting: boolean; onAccept: () => void; onReevaluate: () => void; onBack: () => void }) {
  const intl = useIntl();
  const { copDecimal, copDecimalAmount, dayMonthYear, dateTime } = useFormatters();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return <section className="step">
    <div className="offer-grid">
      <div className="offer-card">
        <div className="offer-head">
          <h1 ref={heading} tabIndex={-1} className="offer-label">{t(offer.status === 'preliminary' ? 'offer.preliminaryTitle' : 'offer.label')}</h1>
        </div>
        <p className="offer-caption">{t('offer.premium')}</p>
        <p className="offer-premium">{copDecimalAmount(offer.premium)} <span className="offer-unit">{t('offer.perMonth')}</span></p>
        {offer.status === 'definitive' && <>
          <p className="offer-billing">{t(assisted ? 'offer.billingAssisted' : 'document.billing')}</p>
          {assisted ? <p className="offer-billing offer-billing-relation">{t('offer.preparedByAdvisor')}</p>
            : <details className="offer-estimate"><summary>{t('offer.aboutEstimate')}</summary><p className="offer-billing offer-billing-relation">{t('document.billingDetail')}</p></details>}
        </>}
        <dl className="offer-facts">
          <div><dt>{t('offer.sumInsured')}</dt><dd className="mono-light">{copDecimal(offer.sumInsured)}</dd></div>
          <div><dt>{t('offer.coverage')}</dt><dd>{t('offer.coverageValue')}</dd></div>
          <div><dt>{t('offer.period')}</dt><dd>{t('offer.periodValue', { from: dayMonthYear(new Date(offer.effectiveFrom)), until: dayMonthYear(new Date(offer.effectiveUntil)) })}</dd></div>
        </dl>
        <details className="offer-verification"><summary>{t('document.verification')}</summary>
          <dl className="offer-facts"><div><dt>{t('document.offerId')}</dt><dd className="offer-id">{offer.offerId}</dd></div>
            <div><dt>{t('offer.rule')}</dt><dd className="mono-light">{offer.ruleVersion}</dd></div></dl>
        </details>
      </div>
      <div className="card offer-side">
        <h2 className="section-label">{t('offer.basis')}</h2>
        <ul className="kept">
          <li><span aria-hidden="true" className="mark mark-ok"><Icon name="check" size={16} /></span>{t('offer.basisConsent')}</li>
          <li><span aria-hidden="true" className="mark mark-ok"><Icon name="check" size={16} /></span>{t('offer.basisRule')}</li>
          <li><span aria-hidden="true" className="mark mark-info"><Icon name="info" size={16} /></span>{t('offer.basisMock')}</li>
        </ul>
        <p className="note">{t(offer.status === 'preliminary' ? 'offer.preliminaryDetail' : 'offer.nextSteps')}</p>
      </div>
    </div>
    <div className="actions">
      {offer.status === 'preliminary'
        ? <button type="button" className="btn btn-primary" onClick={onReevaluate}><Icon name="refresh" size={18} />{t('offer.reevaluate')}</button>
        : <button type="button" className="btn btn-primary" onClick={onAccept} disabled={accepting}><Icon name="check" size={18} />{t(accepting ? 'offer.accepting' : 'offer.accept')}</button>}
      <button type="button" className="btn btn-secondary" onClick={onBack} disabled={accepting}><Icon name="back" size={18} />{t('offer.back')}</button>
      <span className="note offer-expiry"><Icon name="clock" size={16} />{t('offer.expires', { date: dateTime(new Date(offer.expiresAt)) })}</span>
    </div>
  </section>;
}

export function PolicyDocument({ heading, policy, holderName, stage, checked, documentChanged, challenge, code, busy, error, onCode, onCheck, onBegin, onCancel, onConfirm, onContinue }: {
  heading: RefObject<HTMLHeadingElement | null>; policy: Policy; holderName?: string; stage: 'review' | 'sign'; checked: boolean; documentChanged: boolean;
  challenge: SignatureChallenge | null; code: string; busy: boolean; error: string | null;
  onCode: (code: string) => void; onCheck: (checked: boolean) => void; onBegin: () => void; onCancel: () => void; onConfirm: () => void; onContinue: () => void;
}) {
  const intl = useIntl();
  const { copDecimal } = useFormatters();
  const [page, setPage] = useState<1 | 2>(1);
  const [readSecond, setReadSecond] = useState(false);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef(page);
  const { print, portal } = usePrintSheet();
  useEffect(() => {
    if (previousPage.current !== page) pageHeading.current?.focus();
    previousPage.current = page;
  }, [page]);
  const turn = (next: 1 | 2) => { setPage(next); if (next === 2) setReadSecond(true); };
  const [now, setNow] = useState(Date.now());
  const codeInput = useRef<HTMLInputElement>(null);
  const challengeId = challenge?.challengeId;
  useEffect(() => { if (challengeId) codeInput.current?.focus(); }, [challengeId]);
  useEffect(() => { if (error && challengeId) codeInput.current?.focus(); }, [error, challengeId]);
  const hadChallenge = useRef(false);
  useEffect(() => {
    if (challengeId) { hadChallenge.current = true; return; }
    if (hadChallenge.current) { hadChallenge.current = false; window.document.getElementById('policy-review-cb')?.focus(); }
  }, [challengeId]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const secondsLeft = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000)) : 0;
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const number = policyNumber(policy.policyId);
  const printPreview = () => print(t('sheet.fileDraft', { number }), <>
    <DraftPolicyPage policy={policy} page={1} holderName={holderName} stage={stage} />
    <DraftPolicyPage policy={policy} page={2} holderName={holderName} stage={stage} />
  </>);
  return <section className="step">
    {documentChanged && <div className="banner banner-error" role="alert"><Icon name="alert" size={18} className="banner-icon" /><p>{t('policy.documentChanged')}</p></div>}
    <header className="review-heading"><h1 ref={heading} tabIndex={-1} className="h-card">{t(stage === 'sign' ? 'policy.signatureTitle' : 'policy.reviewTitle')}</h1>
      <p className="note">{t(stage === 'sign' ? 'policy.signatureSubtitle' : 'policy.reviewSubtitle')}</p>

    </header>
    <div className={`review-grid review-grid-${stage}`}>
      <div className="card doc-viewer">
        <div className="doc-toolbar">
          <p className="doc-toolbar-name"><Icon name="file" size={18} />{t('policy.document')}</p>
          <div className="doc-toolbar-tools">
            <div className="doc-pager">
              <button type="button" className="btn btn-secondary btn-small" disabled={page === 1} onClick={() => turn(1)} aria-label={t('policy.previousPage')}><Icon name="back" size={16} /></button>
              <span className="mono">{t('policy.page', { current: String(page), total: '2' })}</span>
              <button type="button" className="btn btn-secondary btn-small" disabled={page === 2} onClick={() => turn(2)} aria-label={t('policy.nextPage')}><Icon name="next" size={16} /></button>
            </div>
            <button type="button" className="btn btn-secondary btn-small" onClick={printPreview}><Icon name="printer" size={16} />{t('sheet.printPreview')}</button>
          </div>
        </div>
        <p className="doc-preview-note"><Icon name="info" size={16} />{t('sheet.previewNote')}</p>
        <div className="doc-desk">
          <DraftPolicyPage policy={policy} page={page} holderName={holderName} stage={stage} headingRef={pageHeading} />
          <div className="doc-page-turn">
            {page === 1 ? <button type="button" className="btn btn-secondary" onClick={() => turn(2)}>{t('policy.continueReading')}<Icon name="next" size={16} /></button>
              : <button type="button" className="btn btn-secondary" onClick={() => turn(1)}><Icon name="back" size={16} />{t('policy.backToFirst')}</button>}
          </div>
        </div>
      </div>
      <div className={`card review-panel${stage === 'review' ? ' review-panel-sticky' : ''}`}>
        {stage === 'review' ? <>
          <ol className="review-steps">
            <li data-current={!readSecond || undefined} data-done={readSecond || undefined}>{t('sheet.reviewStepRead')}</li>
            <li data-current={readSecond || undefined}>{t('sheet.reviewStepPay')}</li>
            <li>{t('sheet.reviewStepSign')}</li>
          </ol>
          <button type="button" className="btn btn-primary review-confirm" onClick={onContinue}>
            <Icon name="card" size={18} />{t('policy.continueToPayment', { amount: copDecimal(policy.premium) })}
          </button>
        </> : <>
        <div className="sign-summary">
          <p className="sign-summary-title"><Icon name="signature" size={16} />{t('sheet.signSummary')}</p>
          <dl>
            <div><dt>{t('sheet.signDocument')}</dt><dd>{number}</dd></div>
            <div><dt>{t(policy.payment?.status === 'confirmed' ? 'charge.charged' : 'charge.amount')}</dt><dd className="mono">{copDecimal(policy.premium)}</dd></div>
            <div><dt>{t('sheet.signFingerprint')}</dt><dd className="mono">{policy.documentHash.slice(0, 12)}…</dd></div>
          </dl>
        </div>
        {page !== 2 && !challenge && <p id="policy-page-instruction" className="review-hint"><Icon name="info" size={16} /><span>{t('policy.readBothPages')}</span></p>}
        <div className="check review-check">
          <input id="policy-review-cb" type="checkbox" aria-describedby={page !== 2 && !challenge ? 'policy-page-instruction' : undefined} checked={checked} disabled={page !== 2 || !!challenge || busy} onChange={event => onCheck(event.target.checked)} />
          <label htmlFor="policy-review-cb">{t('policy.check')}</label>
        </div>
        {!challenge && <button type="button" className="btn btn-secondary review-confirm" onClick={onBegin} disabled={!checked || busy}><Icon name="key" size={18} />{t('policy.requestCode')}</button>}
        {challenge && <>
          <label className="section-label" htmlFor="policy-code">{t('policy.authCode')}</label>
          <input id="policy-code" className="signature-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} ref={codeInput}
            aria-invalid={error ? true : undefined} aria-describedby={error ? 'policy-code-error' : undefined}
            value={code} onChange={event => onCode(event.target.value.replace(/\D/g, '').slice(0, 6))} />
          <div className="signature-code-meta">
            <p className="note" role="status">{t('policy.demoCode', { code: challenge.demoCode })}</p>
            <p className="note mono"><Icon name="clock" size={14} />{t('policy.expiresIn', { time: `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}` })}</p>
          </div>
          <button type="button" className="btn btn-primary review-confirm" onClick={onConfirm} disabled={busy || !checked || code.length !== 6 || secondsLeft === 0}><Icon name="signature" size={18} />{t('policy.confirm')}</button>
          <button type="button" className="btn btn-secondary review-confirm" onClick={onCancel} disabled={busy}>{t('policy.cancelSignature')}</button>
        </>}
        {(error || (challenge && secondsLeft === 0)) && <p id="policy-code-error" className="banner banner-error" role="alert">{t(`policy.challenge.${challenge && secondsLeft === 0 ? 'challenge_expired' : error}`)}</p>}
        </>}
        {stage === 'sign' && <p className="note review-mock"><Icon name="info" size={16} />{t('policy.mock')}</p>}
      </div>
    </div>
    {stage === 'review' && <p className="note review-mock"><Icon name="info" size={16} />{t('policy.mock')}</p>}
    {portal}
  </section>;
}

function useSignedAt(policyId: string) {
  const { longDateTime } = useFormatters();
  const intl = useIntl();
  const [signedAt, setSignedAt] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void readPolicyDetail(policyId, abort.signal).then(outcome => {
      if (abort.signal.aborted || outcome.kind !== 'ok') return;
      const signed = outcome.value.documents.find(item => item.documentId === 'signed_policy');
      if (signed) setSignedAt(signed.issuedAt);
    }).catch(() => {});
    return () => abort.abort();
  }, [policyId]);
  return signedAt ? intl.formatMessage({ id: 'sheet.bogotaTime' }, { time: longDateTime(new Date(signedAt)) }) : null;
}

export function PolicyIssued({ heading, policy, holderName }: { heading: RefObject<HTMLHeadingElement | null>; policy: Policy; holderName?: string }) {
  const intl = useIntl();
  const [download, setDownload] = useState<'idle' | 'busy' | 'failed' | 'done'>('idle');
  const signedAt = useSignedAt(policy.policyId);
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const fileName = `${t('sheet.fileSignedPolicy', { number: policyNumber(policy.policyId) })}.pdf`;
  async function save() {
    setDownload('busy');
    const outcome = await downloadDocument(policy.policyId, 'signed_policy');
    if (outcome.kind !== 'ok') { setDownload('failed'); return; }
    savePdf(outcome.value.blob, fileName);
    setDownload('done');
  }
  return <section className="step">
    <div className="doc-status-line">
      <div className="status-head">
        <span className="status-icon status-icon-ok" aria-hidden="true"><Icon name="check" size={18} /></span>
        <div>
          <h1 ref={heading} tabIndex={-1} className="h-card">{t('issued.title')}</h1>
          <p className="note">{t('issued.mock')}</p>
        </div>
      </div>
      <span className="pill pill-ok">{t('issued.badge')}</span>
    </div>
    <div className="doc-action-row">
      <button type="button" className="btn btn-primary" aria-disabled={download === 'busy'} onClick={download === 'busy' ? undefined : () => void save()}>
        <Icon name="download" size={18} />{t(download === 'busy' ? 'sheet.pdfBusy' : 'sheet.pdf')}
      </button>
      <a className="btn btn-secondary" href={`/polizas#policy=${policy.policyId}&section=info`}><Icon name="policy" size={18} />{t('issued.viewPolicy')}</a>
      <span className="note doc-file-name" role="status">{download === 'done' ? t('sheet.downloaded', { file: fileName }) : ''}</span>
    </div>
    {download === 'failed' && <div className="banner banner-error doc-download-error" role="alert"><Icon name="alert" size={18} className="banner-icon" />
      <p>{t('sheet.downloadFailed')}</p>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => void save()}>{t('sheet.downloadRetry')}</button>
    </div>}
    <div className="card doc-viewer doc-viewer-spaced">
      <div className="doc-toolbar"><p className="doc-toolbar-name"><Icon name="file" size={18} />{t('sheet.viewerName')}</p></div>
      <div className="doc-desk"><IssuedPolicyPage policy={policy} holderName={holderName} signedAt={signedAt} /></div>
    </div>
  </section>;
}

type ChargeProps = { heading: RefObject<HTMLHeadingElement | null>; policy: Policy };

export function ChargePending({ heading, policy, idempotencyKey, busy, uncertain, onRefresh }: ChargeProps & {
  idempotencyKey: string; busy: boolean; uncertain: boolean; onRefresh: () => void;
}) {
  const intl = useIntl();
  const { copDecimal } = useFormatters();
  const t = (id: string) => intl.formatMessage({ id });
  return <section className="step card" aria-busy={busy}>
    <div className="status-head">
      {busy ? <span className="spinner" aria-hidden="true" /> : <span className="status-icon status-icon-pending" aria-hidden="true"><Icon name="pending" size={18} /></span>}
      <div>
        <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.pendingTitle')}</h1>
        <p className="note">{t('charge.pendingDetail')}</p>
      </div>
    </div>
    {uncertain && <div className="banner banner-error" role="alert"><Icon name="alert" size={18} className="banner-icon" /><p>{t('policy.uncertain')}</p></div>}
    <dl className="facts facts-pairs facts-icons">
      <div><dt><Icon name="card" size={16} />{t('charge.amount')}</dt><dd className="mono-value">{copDecimal(policy.premium)}</dd></div>
      <div><dt><Icon name="key" size={16} />{t('charge.key')}</dt><dd className="mono charge-key">{idempotencyKey}</dd></div>
    </dl>
    <div className="banner banner-info"><Icon name="info" size={18} className="banner-icon" /><p><strong>{t('charge.waitStrong')}</strong> {t('charge.waitDetail')}</p></div>
    <p className="note">{t('policy.mock')}</p>
    <div className="actions">
      <button type="button" className="btn btn-primary" aria-disabled={busy} onClick={busy ? undefined : onRefresh}><Icon name="refresh" size={18} />{t('policy.refresh')}</button>
    </div>
  </section>;
}

export function ChargeDeclined({ heading, policy, onRetry, onBack }: ChargeProps & { onRetry: () => void; onBack: () => void }) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <section className="step card card-error">
    <div className="denied-head">
      <span aria-hidden="true" className="denied-icon"><Icon name="close" size={14} /></span>
      <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.declinedTitle')}</h1>
    </div>
    <div className="denied-body">
      <p>{t('charge.declinedDetail')} <strong>{t('charge.declinedNoCharge')}</strong></p>
      <details className="document-verification"><summary>{t('charge.support')}</summary><p className="trace mono">{t('issued.policy')}: {policy.policyId}<br />{t('issued.reference')}: {policy.traceId}</p></details>
      <p className="note">{t('charge.retryNote')}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}><Icon name="refresh" size={18} />{t('charge.retry')}</button>
        <button type="button" className="btn btn-secondary" onClick={onBack}><Icon name="back" size={18} />{t('offer.backToEstimate')}</button>
      </div>
    </div>
  </section>;
}

export function ChargeConfirmed({ heading, policy, idempotencyKey, onContinue }: ChargeProps & { idempotencyKey?: string; onContinue: () => void }) {
  const intl = useIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const { print, portal } = usePrintSheet();
  const number = policyNumber(policy.policyId);
  return <section className="step">
    {policy.replayed && <div className="banner banner-ok"><Icon name="check" size={18} className="banner-icon" /><p><strong>{t('charge.replayedTitle')}</strong> {t('charge.replayedDetail')}</p></div>}
    <div className="doc-status-line">
      <div className="status-head">
        <span className="status-icon status-icon-ok" aria-hidden="true"><Icon name="check" size={18} /></span>
        <div>
          <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.okTitle')}</h1>
          <p className="note">{t('charge.okDetail')}</p>
        </div>
      </div>
    </div>
    <div className="doc-action-row">
      <button type="button" className="btn btn-primary" onClick={onContinue}><Icon name="signature" size={18} />{t('charge.continue')}</button>
      <button type="button" className="btn btn-secondary" onClick={() => print(t('sheet.fileReceipt', { number }), <ReceiptPage policy={policy} />)}><Icon name="printer" size={18} />{t('sheet.printReceipt')}</button>
    </div>
    <div className="card doc-viewer doc-viewer-spaced">
      <div className="doc-toolbar"><p className="doc-toolbar-name"><Icon name="file" size={18} />{t('sheet.receiptTitle')}</p></div>
      <div className="doc-desk"><ReceiptPage policy={policy} /></div>
    </div>
    <details className="document-verification"><summary>{t('charge.support')}</summary>
      <p className="trace mono">{t('issued.policy')}: {policy.policyId}{idempotencyKey && <><br />{t('charge.key')}: <span className="charge-key">{idempotencyKey}</span></>}</p>
    </details>
    <p className="note">{t('policy.mock')}</p>
    {portal}
  </section>;
}
