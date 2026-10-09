import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useFormatters, useLocale } from '../i18n/I18n';
import { useAnnounce } from '../quote/Live';
import { consentApi, newIdempotencyKey, type Consent, type ConsentApi, type Terms } from './api';
import { SUPPORTED_TEXT_VERSION } from './wording';

type Load = 'loading' | 'ready' | 'error' | 'mismatch';
type Problem = 'none' | 'grant' | 'decline' | 'outdated';

export function ConsentStep({ quoteRef, api = consentApi, onGranted, onDeclined, onSessionLost }: {
  quoteRef?: string;
  api?: Pick<ConsentApi, 'getTerms' | 'grantConsent' | 'declineConsent'>;
  onGranted: (consent: Consent) => void;
  onDeclined: () => void;
  onSessionLost?: () => void;
}) {
  const intl = useIntl();
  const { dayMonthYear } = useFormatters();
  const { locale } = useLocale();
  const announce = useAnnounce();
  const [load, setLoad] = useState<Load>('loading');
  const [terms, setTerms] = useState<Terms | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'authorizing' | 'declining'>('idle');
  const [problem, setProblem] = useState<Problem>('none');
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<AbortController | null>(null);
  // The same key for the same terms, so a repeated click or a retry never records two authorizations.
  const key = useRef(newIdempotencyKey());

  const fetchTerms = useCallback(async () => {
    pending.current?.abort();
    pending.current = new AbortController();
    try {
      const outcome = await api.getTerms(pending.current.signal);
      if (outcome.kind === 'ok' && outcome.value.textVersion !== SUPPORTED_TEXT_VERSION) { setLoad('mismatch'); announce(intl.formatMessage({ id: 'consent.versionMismatch' })); }
      else if (outcome.kind === 'ok') { setTerms(outcome.value); setLoad('ready'); announce(intl.formatMessage({ id: 'live.consent' })); }
      else if (outcome.kind === 'unauthenticated') onSessionLost?.();
      else { setLoad('error'); announce(intl.formatMessage({ id: 'consent.errorTerms' })); }
    } catch { /* aborted: the user left the screen */ }
  }, [api, announce, intl, onSessionLost]);

  useEffect(() => { void fetchTerms(); return () => pending.current?.abort(); }, [fetchTerms]);
  useEffect(() => { if (load !== 'loading') heading.current?.focus(); }, [load]);
  useEffect(() => { key.current = newIdempotencyKey(); }, [locale]);

  function reload() { setLoad('loading'); void fetchTerms(); }

  async function authorize() {
    if (!terms || !checked || busy !== 'idle') return;
    setBusy('authorizing'); setProblem('none');
    const outcome = await api.grantConsent({ textVersion: SUPPORTED_TEXT_VERSION, locale, ...(quoteRef ? { quoteRef } : {}) }, key.current);
    setBusy('idle');
    if (outcome.kind === 'ok') {
      announce(intl.formatMessage({ id: 'live.consentGranted' }, { date: dayMonthYear(new Date(outcome.value.expiresAt)) }));
      onGranted(outcome.value);
    } else if (outcome.kind === 'unauthenticated') {
      announce(intl.formatMessage({ id: 'live.sessionExpired' })); onSessionLost?.();
    } else if (outcome.kind === 'outdated') {
      key.current = newIdempotencyKey(); setChecked(false); setProblem('outdated');
      announce(intl.formatMessage({ id: 'live.consentOutdated' })); reload();
    } else {
      if (outcome.kind === 'conflict') key.current = newIdempotencyKey();
      setProblem('grant'); announce(intl.formatMessage({ id: 'live.consentError' }));
    }
  }

  async function decline() {
    if (!terms || busy !== 'idle') return;
    setBusy('declining'); setProblem('none');
    const outcome = await api.declineConsent(SUPPORTED_TEXT_VERSION);
    setBusy('idle');
    if (outcome.kind === 'unauthenticated') { announce(intl.formatMessage({ id: 'live.sessionExpired' })); onSessionLost?.(); return; }
    if (outcome.kind === 'outdated') {
      key.current = newIdempotencyKey(); setChecked(false); setProblem('outdated');
      announce(intl.formatMessage({ id: 'live.consentOutdated' })); reload(); return;
    }
    if (outcome.kind !== 'ok') {
      setProblem('decline'); announce(intl.formatMessage({ id: 'consent.errorDecline' })); return;
    }
    announce(intl.formatMessage({ id: 'live.consentDeclined' }));
    onDeclined();
  }

  if (load === 'loading') {
    return <section className="step card" aria-busy="true">
      <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'consent.loading' })}</h1>
      <p>{intl.formatMessage({ id: 'consent.loadingDetail' })}</p>
    </section>;
  }
  if (load === 'error' || load === 'mismatch' || !terms) {
    return <section className="step">
      <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'consent.title' })}</h1>
      <div className="banner banner-error"><span aria-hidden="true" className="banner-icon">!</span><p>{intl.formatMessage({ id: load === 'mismatch' ? 'consent.versionMismatch' : 'consent.errorTerms' })}</p></div>
      <button type="button" className="btn btn-primary" onClick={reload}>{intl.formatMessage({ id: 'consent.retry' })}</button>
    </section>;
  }

  return <section className="step">
    {problem !== 'none' && <div className="banner banner-error">
      <span aria-hidden="true" className="banner-icon">!</span>
      <p>{intl.formatMessage({ id: problem === 'outdated' ? 'consent.outdated' : problem === 'decline' ? 'consent.errorDecline' : 'consent.errorGrant' })}</p>
    </div>}
    <div className="card consent-card">
      <header className="consent-head">
        <h1 ref={heading} tabIndex={-1} className="h-card">{intl.formatMessage({ id: 'consent.title' })}</h1>
        <p className="note">{intl.formatMessage({ id: 'consent.subtitle' })}</p>
      </header>
      <div className="consent-body">
        <div>
          <h2 className="section-label">{intl.formatMessage({ id: 'consent.purpose' })}</h2>
          <p className="consent-text">{intl.formatMessage({ id: 'consent.purposeText' })}</p>
          <p className="note">{intl.formatMessage({ id: 'consent.purposeNote' })}</p>
          <h2 className="section-label consent-gap">{intl.formatMessage({ id: 'consent.validity' })}</h2>
          <p className="validity">
            <span className="pill pill-open_finance">{intl.formatMessage({ id: 'consent.validityDays' }, { days: terms.validityDays })}</span>
            <span>{intl.formatMessage({ id: 'consent.validityStart' })}</span>
          </p>
          <p className="note">{intl.formatMessage({ id: 'consent.revokeNote' })}</p>
        </div>
        <div>
          <h2 className="section-label">{intl.formatMessage({ id: 'consent.sources' })}</h2>
          <ul className="sources">
            {terms.sources.map(source => <li key={source.code} className="source-row">
              <span>
                <span className="source-name">{intl.formatMessage({ id: `source.${source.code}.name`, defaultMessage: source.code })}</span>
                <span className="note">{intl.formatMessage({ id: `source.${source.code}.detail`, defaultMessage: source.scope })}</span>
              </span>
              <span className={`pill pill-${source.kind}`}>{intl.formatMessage({ id: `kind.${source.kind}` })}</span>
            </li>)}
          </ul>
          <p className="note">{intl.formatMessage({ id: 'consent.dane' })}</p>
        </div>
      </div>
      <div className="consent-foot">
        <div className="check">
          <input id="consent-cb" type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={busy !== 'idle'} />
          <label htmlFor="consent-cb">{intl.formatMessage({ id: 'consent.check' })}</label>
        </div>
        <div className="actions actions-end">
          <button type="button" className="btn btn-secondary" onClick={() => void decline()} disabled={busy !== 'idle'}>{intl.formatMessage({ id: 'consent.decline' })}</button>
          <button type="button" className="btn btn-primary" onClick={() => void authorize()} disabled={!checked || busy !== 'idle'}>
            {intl.formatMessage({ id: busy === 'authorizing' ? 'consent.submitting' : 'consent.authorize' })}
          </button>
        </div>
      </div>
    </div>
  </section>;
}
