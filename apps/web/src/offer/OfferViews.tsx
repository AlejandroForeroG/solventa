import type { RefObject } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import type { Offer, Policy } from './api';

// Offers the exact reviewed bytes as a file; nothing is reformatted or re-signed in the browser.
function downloadDocument(policy: Policy) {
  const url = URL.createObjectURL(new Blob([policy.document], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `poliza-${policy.policyId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function OfferCard({ heading, offer, accepting, onAccept, onBack }: { heading: RefObject<HTMLHeadingElement | null>; offer: Offer; accepting: boolean; onAccept: () => void; onBack: () => void }) {
  const intl = useIntl();
  const { copDecimal, copDecimalAmount, dayMonthYear, dateTime } = useFormatters();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return <section className="step">
    <div className="offer-grid">
      <div className="offer-card">
        <div className="offer-head">
          <h1 ref={heading} tabIndex={-1} className="offer-label">{t('offer.label')}</h1>
          <span className="offer-id">{offer.offerId}</span>
        </div>
        <p className="offer-caption">{t('offer.premium')}</p>
        <p className="offer-premium">{copDecimalAmount(offer.premium)} <span className="offer-unit">{t('offer.perMonth')}</span></p>
        <dl className="offer-facts">
          <div><dt>{t('offer.sumInsured')}</dt><dd className="mono-light">{copDecimal(offer.sumInsured)}</dd></div>
          <div><dt>{t('offer.coverage')}</dt><dd>{t('offer.coverageValue')}</dd></div>
          <div><dt>{t('offer.period')}</dt><dd className="mono-light">{t('offer.periodValue', { from: dayMonthYear(new Date(offer.effectiveFrom)), until: dayMonthYear(new Date(offer.effectiveUntil)) })}</dd></div>
          <div><dt>{t('offer.rule')}</dt><dd className="mono-light">{offer.ruleVersion}</dd></div>
        </dl>
      </div>
      <div className="card offer-side">
        <h2 className="section-label">{t('offer.basis')}</h2>
        <ul className="kept">
          <li><span aria-hidden="true" className="mark mark-ok">✓</span>{t('offer.basisConsent')}</li>
          <li><span aria-hidden="true" className="mark mark-ok">✓</span>{t('offer.basisRule')}</li>
          <li><span aria-hidden="true" className="mark mark-no">!</span>{t('offer.basisMock')}</li>
        </ul>
        <p className="note">{t('offer.nextSteps')}</p>
      </div>
    </div>
    <div className="actions">
      <button type="button" className="btn btn-primary" onClick={onAccept} disabled={accepting}>{t(accepting ? 'offer.accepting' : 'offer.accept')}</button>
      <button type="button" className="btn btn-secondary" onClick={onBack} disabled={accepting}>{t('offer.back')}</button>
      <span className="note">{t('offer.expires', { date: dateTime(new Date(offer.expiresAt)) })}</span>
    </div>
  </section>;
}

export function PolicyDocument({ heading, policy, checked, documentChanged, onCheck, onConfirm }: {
  heading: RefObject<HTMLHeadingElement | null>; policy: Policy; checked: boolean; documentChanged: boolean;
  onCheck: (checked: boolean) => void; onConfirm: () => void;
}) {
  const intl = useIntl();
  const { copDecimal, dayMonthYear } = useFormatters();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return <section className="step">
    {documentChanged && <div className="banner banner-error" role="alert"><span aria-hidden="true" className="banner-icon">!</span><p>{t('policy.documentChanged')}</p></div>}
    <div className="review-grid">
      <div className="card document-card">
        <div className="document-bar">
          <span className="mono">{`poliza-${policy.policyId}.json`}</span>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => downloadDocument(policy)}>{t('policy.download')}</button>
        </div>
        <div className="document-body">
          <dl className="facts">
            <div><dt>{t('issued.policy')}</dt><dd className="mono">{policy.policyId}</dd></div>
            <div><dt>{t('issued.premium')}</dt><dd className="mono-value">{copDecimal(policy.premium)}</dd></div>
            <div><dt>{t('offer.period')}</dt><dd className="mono">{t('offer.periodValue', { from: dayMonthYear(new Date(policy.effectiveFrom)), until: dayMonthYear(new Date(policy.effectiveUntil)) })}</dd></div>
          </dl>
          <h2 className="section-label">{t('policy.document')}</h2>
          <pre className="document-text" tabIndex={0} aria-label={t('policy.document')}>{policy.document}</pre>
          <p className="seal-line mono">{t('policy.hash')}: {policy.documentHash}</p>
        </div>
      </div>
      <div className="card review-panel">
        <h1 ref={heading} tabIndex={-1} className="h-card">{t('policy.reviewTitle')}</h1>
        <p className="note">{t('policy.reviewSubtitle')}</p>
        <div className="check review-check">
          <input id="policy-review-cb" type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} />
          <label htmlFor="policy-review-cb">{t('policy.check')}</label>
        </div>
        <button type="button" className="btn btn-primary review-confirm" onClick={onConfirm} disabled={!checked}>{t('policy.confirm')}</button>
        <p className="note">{t('policy.mock')}</p>
      </div>
    </div>
  </section>;
}

export function PolicyIssued({ heading, policy }: { heading: RefObject<HTMLHeadingElement | null>; policy: Policy }) {
  const intl = useIntl();
  const { copDecimal, dayMonthYear } = useFormatters();
  const t = (id: string) => intl.formatMessage({ id });
  return <section className="step">
    <div className="banner banner-ok"><span aria-hidden="true" className="banner-icon">✓</span><p><strong>{t('issued.onceTitle')}</strong> {t('issued.onceDetail')}</p></div>
    <div className="card">
      <div className="result-head">
        <h1 ref={heading} tabIndex={-1} className="h-card">{t('issued.title')}</h1>
        <span className="pill pill-ok">{t('issued.badge')}</span>
      </div>
      <dl className="facts">
        <div><dt>{t('issued.policy')}</dt><dd className="mono">{policy.policyId}</dd></div>
        <div><dt>{t('issued.premium')}</dt><dd className="mono-value">{copDecimal(policy.premium)}</dd></div>
        <div><dt>{t('issued.start')}</dt><dd className="mono">{dayMonthYear(new Date(policy.effectiveFrom))}</dd></div>
        <div><dt>{t('issued.end')}</dt><dd className="mono">{dayMonthYear(new Date(policy.effectiveUntil))}</dd></div>
      </dl>
      <h2 className="section-label">{t('issued.proof')}</h2>
      <p className="trace mono">{t('policy.hash')}: {policy.documentHash}<br />{t('issued.reference')}: {policy.traceId}</p>
      <p className="note">{t('issued.mock')}</p>
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={() => downloadDocument(policy)}>{t('policy.download')}</button>
      </div>
    </div>
  </section>;
}

type ChargeProps = { heading: RefObject<HTMLHeadingElement | null>; policy: Policy };

// While a request is in flight the action stays focusable but inert, so focus is not lost and a repeated click sends nothing.
export function ChargePending({ heading, policy, idempotencyKey, busy, uncertain, onRefresh }: ChargeProps & {
  idempotencyKey: string; busy: boolean; uncertain: boolean; onRefresh: () => void;
}) {
  const intl = useIntl();
  const { copDecimal } = useFormatters();
  const t = (id: string) => intl.formatMessage({ id });
  return <section className="step card" aria-busy={busy}>
    <div className="status-head">
      {busy ? <span className="spinner" aria-hidden="true" /> : <span className="status-icon status-icon-pending" aria-hidden="true">…</span>}
      <div>
        <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.pendingTitle')}</h1>
        <p className="note">{t('charge.pendingDetail')}</p>
      </div>
    </div>
    {uncertain && <div className="banner banner-error" role="alert"><span aria-hidden="true" className="banner-icon">!</span><p>{t('policy.uncertain')}</p></div>}
    <dl className="facts">
      <div><dt>{t('charge.amount')}</dt><dd className="mono-value">{copDecimal(policy.premium)}</dd></div>
      <div><dt>{t('charge.key')}</dt><dd className="mono charge-key">{idempotencyKey}</dd></div>
    </dl>
    <div className="banner banner-info"><span aria-hidden="true" className="banner-icon">i</span><p><strong>{t('charge.waitStrong')}</strong> {t('charge.waitDetail')}</p></div>
    <p className="note">{t('policy.mock')}</p>
    <div className="actions">
      <button type="button" className="btn btn-primary" aria-disabled={busy} onClick={busy ? undefined : onRefresh}>{t('policy.refresh')}</button>
    </div>
  </section>;
}

export function ChargeDeclined({ heading, policy, onRetry, onBack }: ChargeProps & { onRetry: () => void; onBack: () => void }) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <section className="step card card-error">
    <div className="denied-head">
      <span aria-hidden="true" className="denied-icon">×</span>
      <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.declinedTitle')}</h1>
    </div>
    <div className="denied-body">
      <p>{t('charge.declinedDetail')} <strong>{t('charge.declinedNoCharge')}</strong></p>
      <p className="trace mono">{t('issued.policy')}: {policy.policyId}<br />{t('issued.reference')}: {policy.traceId}</p>
      <p className="note">{t('charge.retryNote')}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>{t('charge.retry')}</button>
        <button type="button" className="btn btn-secondary" onClick={onBack}>{t('offer.backToEstimate')}</button>
      </div>
    </div>
  </section>;
}

export function ChargeConfirmed({ heading, policy, idempotencyKey, onContinue }: ChargeProps & { idempotencyKey: string; onContinue: () => void }) {
  const intl = useIntl();
  const { copDecimal } = useFormatters();
  const t = (id: string) => intl.formatMessage({ id });
  return <section className="step">
    {policy.replayed && <div className="banner banner-ok"><span aria-hidden="true" className="banner-icon">✓</span><p><strong>{t('charge.replayedTitle')}</strong> {t('charge.replayedDetail')}</p></div>}
    <div className="card">
      <div className="status-head">
        <span className="status-icon status-icon-ok" aria-hidden="true">✓</span>
        <div>
          <h1 ref={heading} tabIndex={-1} className="h-card">{t('charge.okTitle')}</h1>
          <p className="note">{t('charge.okDetail')}</p>
        </div>
      </div>
      <dl className="facts facts-pairs">
        <div><dt>{t('charge.receipt')}</dt><dd className="mono">{policy.payment?.reference}</dd></div>
        <div><dt>{t('charge.charged')}</dt><dd className="mono-value">{copDecimal(policy.premium)}</dd></div>
        <div><dt>{t('charge.key')}</dt><dd className="mono charge-key">{idempotencyKey}</dd></div>
        <div><dt>{t('issued.policy')}</dt><dd className="mono">{policy.policyId}</dd></div>
      </dl>
      <p className="note">{t('policy.mock')}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onContinue}>{t('charge.continue')}</button>
      </div>
    </div>
  </section>;
}
