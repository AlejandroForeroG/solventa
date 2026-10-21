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

export function PolicyDocument({ heading, policy, checked, confirming, problem, onCheck, onConfirm }: {
  heading: RefObject<HTMLHeadingElement | null>; policy: Policy; checked: boolean; confirming: boolean; problem?: 'uncertain' | 'document_changed';
  onCheck: (checked: boolean) => void; onConfirm: () => void;
}) {
  const intl = useIntl();
  const { copDecimal, dayMonthYear } = useFormatters();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return <section className="step">
    {problem && <div className="banner banner-error" role="alert"><span aria-hidden="true" className="banner-icon">!</span><p>{t(problem === 'uncertain' ? 'policy.uncertain' : 'policy.documentChanged')}</p></div>}
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
          <input id="policy-review-cb" type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} disabled={confirming} />
          <label htmlFor="policy-review-cb">{t('policy.check')}</label>
        </div>
        <button type="button" className="btn btn-primary review-confirm" onClick={onConfirm} disabled={!checked || confirming}>{t(confirming ? 'policy.confirming' : problem === 'uncertain' ? 'policy.retryConfirm' : 'policy.confirm')}</button>
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
