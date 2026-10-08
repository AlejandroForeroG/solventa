import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters } from '../i18n/I18n';
import type { Quote } from './api';

export function Loading() {
  const intl = useIntl();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="step card" aria-busy="true">
    <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'loading.title' })}</h1>
    <p>{intl.formatMessage({ id: 'loading.detail' })}</p>
  </section>;
}

export function QuoteResult({ quote, onFix, onContinue }: { quote: Quote; onFix: () => void; onContinue?: () => void }) {
  const intl = useIntl();
  const { cop, copAmount, monthYear, dayMonthYear } = useFormatters();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const creditEnd = new Date();
  creditEnd.setMonth(creditEnd.getMonth() + quote.termMonths);
  return <section className="step">
    <div className="banner banner-info">
      <span aria-hidden="true" className="banner-icon">i</span>
      <p><strong>{intl.formatMessage({ id: 'result.minTitle' })}</strong> {intl.formatMessage({ id: 'result.minDetail' })}</p>
    </div>
    <div className="card">
      <div className="result-head">
        <div>
          <h1 ref={heading} tabIndex={-1} className="section-label">{intl.formatMessage({ id: 'result.label' })}</h1>
          <p className="mono">{quote.quoteId}</p>
        </div>
        <span className="pill pill-ok">{intl.formatMessage({ id: 'result.validUntil' }, { date: dayMonthYear(new Date(quote.validUntil)) })}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>{intl.formatMessage({ id: 'result.premium' })}</dt>
          <dd className="premium-value">{copAmount(quote.premiumMonthly)}</dd>
          <dd className="note mono">{intl.formatMessage({ id: 'result.perMonth' })}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'result.sumInsured' })}</dt>
          <dd className="mono-value">{cop(quote.sumInsured)}</dd>
          <dd className="note">{intl.formatMessage({ id: 'result.sumInsuredNote' })}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'result.creditTerm' })}</dt>
          <dd className="mono-value">{intl.formatMessage({ id: 'result.termMonths' }, { n: quote.termMonths })}</dd>
          <dd className="note">{intl.formatMessage({ id: 'result.creditTermUntil' }, { date: monthYear(creditEnd) })}</dd>
        </div>
      </dl>
      <p className="note">{intl.formatMessage({ id: 'result.note' })}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onContinue} disabled={!onContinue}>{intl.formatMessage({ id: 'result.continue' })}</button>
        <button type="button" className="btn btn-secondary" onClick={onFix}>{intl.formatMessage({ id: 'result.fix' })}</button>
      </div>
    </div>
  </section>;
}

export function Denied({ traceId, onRetry, onBack }: { traceId?: string; onRetry: () => void; onBack: () => void }) {
  const intl = useIntl();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  // One fixed message for every cause: absent, unknown, revoked or out-of-scope credentials.
  return <section className="step card card-error">
    <div className="denied-head">
      <span aria-hidden="true" className="denied-icon">×</span>
      <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'denied.title' })}</h1>
    </div>
    <div className="denied-body">
      <p>{intl.formatMessage({ id: 'denied.detail' })}</p>
      {traceId && <p className="trace mono">{intl.formatMessage({ id: 'denied.trace' })}: {traceId}</p>}
      <p className="note">{intl.formatMessage({ id: 'denied.note' })}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>{intl.formatMessage({ id: 'denied.retry' })}</button>
        <button type="button" className="btn btn-secondary" onClick={onBack}>{intl.formatMessage({ id: 'denied.back' })}</button>
      </div>
    </div>
  </section>;
}
