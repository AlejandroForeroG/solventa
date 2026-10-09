import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import type { Consent } from './api';

export function ConsentGranted({ consent, onPanel, onBack }: { consent: Consent; onPanel?: () => void; onBack: () => void }) {
  const intl = useIntl();
  const { dayMonthYear } = useFormatters();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="step card">
    <div className="result-head">
      <div>
        <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'granted.title' })}</h1>
        <p className="mono">{intl.formatMessage({ id: 'granted.id' })} {consent.consentId}</p>
      </div>
      <span className="pill pill-ok">{intl.formatMessage({ id: 'granted.validUntil' }, { date: dayMonthYear(new Date(consent.expiresAt)) })}</span>
    </div>
    <p>{intl.formatMessage({ id: 'granted.detail' })}</p>
    <div className="actions">
      {onPanel && <button type="button" className="btn btn-primary" onClick={onPanel}>{intl.formatMessage({ id: 'granted.panel' })}</button>}
      <button type="button" className="btn btn-secondary" onClick={onBack}>{intl.formatMessage({ id: 'granted.back' })}</button>
    </div>
  </section>;
}

export function ConsentDeclined({ premium, onReview, onBack }: { premium: number; onReview: () => void; onBack: () => void }) {
  const intl = useIntl();
  const { cop } = useFormatters();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="step card declined-card">
    <header className="consent-head">
      <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'declined.title' })}</h1>
      <p className="note">{intl.formatMessage({ id: 'declined.subtitle' })}</p>
    </header>
    <div className="declined-body">
      <ul className="kept">
        <li><span aria-hidden="true" className="mark mark-ok">✓</span>{intl.formatMessage({ id: 'declined.keep' }, { premium: cop(premium), strong: chunks => <strong>{chunks}</strong> })}</li>
        <li><span aria-hidden="true" className="mark mark-no">×</span>{intl.formatMessage({ id: 'declined.noOffer' })}</li>
        <li><span aria-hidden="true" className="mark mark-no">×</span>{intl.formatMessage({ id: 'declined.noPolicy' })}</li>
      </ul>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onReview}>{intl.formatMessage({ id: 'declined.review' })}</button>
        <button type="button" className="btn btn-secondary" onClick={onBack}>{intl.formatMessage({ id: 'declined.back' })}</button>
      </div>
    </div>
  </section>;
}
